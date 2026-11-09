import assert from "node:assert/strict";
import { test } from "node:test";

import { listenFd } from "./http.ts";

// listenFd() reads the ambient environment, so give each case its own and put
// the real one back afterwards.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = { LISTEN_PID: process.env.LISTEN_PID, LISTEN_FDS: process.env.LISTEN_FDS };
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("listenFd - an activated socket is fd 3", () => {
  const fd = withEnv({ LISTEN_PID: String(process.pid), LISTEN_FDS: "1" }, listenFd);
  assert.equal(fd, 3);
});

test("listenFd - no LISTEN_FDS means we were not socket-activated", () => {
  const fd = withEnv({ LISTEN_PID: undefined, LISTEN_FDS: undefined }, listenFd);
  assert.equal(fd, null);
});

test("listenFd - ignores a socket passed to a different process", () => {
  // systemd's variables survive into children, where fd 3 means something else.
  const fd = withEnv({ LISTEN_PID: String(process.pid + 1), LISTEN_FDS: "1" }, listenFd);
  assert.equal(fd, null);
});

test("listenFd - ignores a non-positive or unparseable count", () => {
  for (const LISTEN_FDS of ["0", "-1", "", "many"]) {
    const fd = withEnv({ LISTEN_PID: String(process.pid), LISTEN_FDS }, listenFd);
    assert.equal(fd, null, `LISTEN_FDS=${JSON.stringify(LISTEN_FDS)}`);
  }
});

test("listenFd - takes the first of several activated sockets", () => {
  const fd = withEnv({ LISTEN_PID: String(process.pid), LISTEN_FDS: "3" }, listenFd);
  assert.equal(fd, 3);
});
