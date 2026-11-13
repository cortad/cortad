import { first } from "./env.mjs";

// Stores an app keeps conversations in that Cortad does not read itself yet: each is found by its
// env so the command can say so plainly and point at the export instead of guessing at another store.
const has = (env, names) => first(env, names)[0];
const pending = (kind, label, names) => ({
  kind, label, pending: true,
  find: (env) => { const name = has(env, names); return name ? [{ kind, host: "", envNames: [name] }] : []; },
});

export const PENDING = [
  pending("firestore", "Firestore", ["FIRESTORE_EMULATOR_HOST", "FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_KEY", "FIREBASE_PRIVATE_KEY"]),
  pending("dynamodb", "DynamoDB", ["DYNAMODB_ENDPOINT", "DYNAMODB_TABLE", "DYNAMODB_TABLE_NAME", "AWS_ENDPOINT_URL_DYNAMODB", "DYNAMO_TABLE"]),
  pending("milvus", "Milvus", ["MILVUS_URI", "MILVUS_URL", "MILVUS_HOST", "MILVUS_ENDPOINT", "ZILLIZ_CLOUD_URI", "ZILLIZ_URI", "ZILLIZ_ENDPOINT"]),
  pending("pinecone", "Pinecone", ["PINECONE_API_KEY"]),
  pending("cassandra", "Cassandra", ["CASSANDRA_CONTACT_POINTS", "CASSANDRA_HOSTS", "CASSANDRA_HOST", "ASTRA_DB_API_ENDPOINT", "ASTRA_DB_APPLICATION_TOKEN", "ASTRA_DB_SECURE_BUNDLE_PATH"]),
];
