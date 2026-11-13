import assert from "node:assert/strict";
import { test } from "node:test";
import { signed } from "./sigv4.mjs";

// AWS's own Signature Version 4 test suite, case get-vanilla.
test("a request is signed exactly as AWS's test suite signs it", () => {
  const headers = signed({ method: "GET", url: "https://example.amazonaws.com/", region: "us-east-1", service: "service", key: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", at: new Date("2015-08-30T12:36:00Z") });
  assert.equal(headers.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
});
