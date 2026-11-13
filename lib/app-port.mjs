const NOT_AN_APP = /trying to access MongoDB over HTTP|^-ERR |^\$\d+\r?\n|^\+PONG/m;
const STORE_URL = /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|redis|rediss|mysql|mariadb|amqp|nats):\/\/\S+/gi;

export const notAnApp = (head) => NOT_AN_APP.test(head);
export const withoutStores = (log) => log.replace(STORE_URL, "");
