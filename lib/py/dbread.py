# A read-only session on the app's own database, through the driver the app itself installed, for
# lib/history/db/drivers.mjs. The first line on stdin opens it ({"open": {...}}); every line after
# is one read, answered by one line on stdout. Nothing else is ever written to stdout.
#
# Only reads leave this file: SQL that is a SELECT, inside a read-only transaction where the database
# has one; MongoDB's find and its collection list; Redis's read commands; CQL that is a SELECT.
import datetime
import decimal
import json
import sys
import uuid

out = sys.stdout
sys.stdout = sys.stderr

READ_REDIS = {"SCAN", "TYPE", "GET", "MGET", "HGETALL", "HMGET", "HGET", "LRANGE", "LLEN", "LINDEX", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE",
              "ZCARD", "SMEMBERS", "SCARD", "XRANGE", "XREVRANGE", "XLEN", "JSON.GET", "JSON.MGET", "JSON.TYPE", "EXISTS", "DBSIZE", "INFO"}


def plain(value):
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.hex()
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [plain(v) for v in value]
    return value


def is_select(text):
    head = text.lstrip().split(None, 1)[0].upper() if text.strip() else ""
    return head in ("SELECT", "WITH")


class Sql:
    def __init__(self, spec):
        self.driver = spec["driver"]
        if self.driver == "psycopg":
            import psycopg
            self.conn = psycopg.connect(spec["url"])
            self.conn.read_only = True
        elif self.driver == "psycopg2":
            import psycopg2
            self.conn = psycopg2.connect(spec["url"])
            self.conn.set_session(readonly=True)
        elif self.driver == "pymysql":
            import pymysql
            self.conn = pymysql.connect(**spec["parts"], autocommit=False)
            with self.conn.cursor() as cur:
                cur.execute("SET time_zone = '+00:00'")
                cur.execute("START TRANSACTION READ ONLY")
        elif self.driver == "MySQLdb":
            import MySQLdb
            parts = {k: v for k, v in spec["parts"].items() if not k.startswith("ssl_")}
            parts["passwd"] = parts.pop("password", "")
            parts["db"] = parts.pop("database", "")
            self.conn = MySQLdb.connect(**parts)
            cur = self.conn.cursor()
            cur.execute("SET time_zone = '+00:00'")
            cur.execute("START TRANSACTION READ ONLY")
        elif self.driver == "pymssql":
            import pymssql
            self.conn = pymssql.connect(**spec["parts"])
        elif self.driver == "pyodbc":
            import pyodbc
            self.conn = pyodbc.connect(spec["odbc"], readonly=True)
        else:
            raise ValueError("no such driver")

    def run(self, req):
        if not is_select(req["sql"]):
            raise ValueError("only a SELECT is read")
        cur = self.conn.cursor()
        params = req.get("params") or None
        cur.execute(req["sql"], tuple(params) if params else None)
        names = [d[0] for d in cur.description or []]
        rows = [dict(zip(names, [plain(v) for v in row])) for row in cur.fetchall()]
        cur.close()
        return rows

    def close(self):
        try:
            self.conn.rollback()
        finally:
            self.conn.close()


class Mongo:
    def __init__(self, spec):
        import pymongo
        from bson import json_util
        self.json_util = json_util
        self.client = pymongo.MongoClient(spec["url"], serverSelectionTimeoutMS=15000)
        self.db = self.client[spec["database"]] if spec.get("database") else None

    def run(self, req):
        op = req["op"]
        if op == "databases":
            return [d for d in self.client.list_database_names() if d not in ("admin", "local", "config")]
        if op == "use":
            self.db = self.client[req["database"]]
            return self.db.name
        if op == "collections":
            return self.db.list_collection_names()
        if op == "find":
            body = self.json_util.loads(json.dumps(req))
            cursor = self.db[body["collection"]].find(body.get("filter") or {}, body.get("projection") or None, allow_disk_use=True)
            if body.get("sort"):
                cursor = cursor.sort(list(body["sort"].items()))
            cursor = cursor.skip(int(body.get("skip") or 0)).limit(int(body.get("limit") or 0))
            return json.loads(self.json_util.dumps(list(cursor), json_options=self.json_util.RELAXED_JSON_OPTIONS))
        raise ValueError("only finds are read")

    def close(self):
        self.client.close()


class Redis:
    def __init__(self, spec):
        import redis
        self.r = redis.Redis.from_url(spec["url"], decode_responses=True, socket_timeout=30)

    def run(self, req):
        out = []
        for cmd in req["cmds"]:
            if str(cmd[0]).upper() not in READ_REDIS:
                raise ValueError("only reads are sent to Redis")
            try:
                out.append({"result": plain(self.r.execute_command(*cmd))})
            except Exception as error:
                out.append({"error": str(error)})
        return out

    def close(self):
        self.r.close()


class Cql:
    def __init__(self, spec):
        from cassandra.auth import PlainTextAuthProvider
        from cassandra.cluster import Cluster
        auth = PlainTextAuthProvider(spec["username"], spec["password"]) if spec.get("username") else None
        if spec.get("bundle"):
            self.cluster = Cluster(cloud={"secure_connect_bundle": spec["bundle"]}, auth_provider=auth)
        else:
            context = None
            if spec.get("tls"):
                import ssl
                context = ssl.create_default_context()
            self.cluster = Cluster(spec["hosts"], port=int(spec.get("port") or 9042), auth_provider=auth, ssl_context=context)
        self.session = self.cluster.connect()

    def run(self, req):
        from cassandra.query import SimpleStatement
        if not is_select(req["cql"]):
            raise ValueError("only a SELECT is read")
        stmt = SimpleStatement(req["cql"], fetch_size=int(req.get("size") or 5000))
        page = bytes.fromhex(req["page"]) if req.get("page") else None
        result = self.session.execute(stmt, req.get("params") or None, paging_state=page)
        rows = [plain(r._asdict()) for r in result.current_rows]
        nxt = result.paging_state
        return {"rows": rows, "next": nxt.hex() if nxt else None}

    def close(self):
        self.cluster.shutdown()


KINDS = {"sql": Sql, "mongo": Mongo, "redis": Redis, "cql": Cql}


def answer(payload):
    out.write(json.dumps(payload, default=str) + "\n")
    out.flush()


def main():
    session = None
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            if "open" in req:
                session = KINDS[req["open"]["kind"]](req["open"])
                answer({"result": True})
            else:
                answer({"result": session.run(req)})
        except Exception as error:
            answer({"error": f"{type(error).__name__}: {error}".splitlines()[0][:300]})
    if session:
        session.close()


main()
