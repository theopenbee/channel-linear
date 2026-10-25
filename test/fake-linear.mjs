import { createServer } from "node:http";

export const API_KEY = "lin_api_test_key";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function connection(nodes, first, after) {
  const start = after ? Number(after) : 0;
  const page = nodes.slice(start, start + first);
  const end = start + page.length;
  return { pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) }, nodes: page };
}

export function issue(overrides = {}) {
  const id = overrides.id ?? "issue-1";
  return {
    id,
    identifier: "ENG-1",
    title: "Fix login",
    description: "",
    url: `https://linear.app/acme/issue/${overrides.identifier ?? "ENG-1"}`,
    createdAt: "2026-10-25T01:00:00.000Z",
    team: { key: "ENG" },
    creator: { id: "user-1", name: "Alice", email: "alice@example.com" },
    project: { id: "p1", name: "Core" },
    state: "Todo",
    labels: ["openbee"],
    comments: [],
    ...overrides,
  };
}

export function comment(overrides = {}) {
  return {
    id: "comment-1",
    body: "hello",
    createdAt: "2026-10-25T02:00:00.000Z",
    user: { id: "user-2", name: "Bob", email: "bob@example.com" },
    parentId: null,
    ...overrides,
  };
}

export async function startFakeLinear() {
  const state = {
    issues: [],
    assets: new Map(),
    uploads: [],
    comments: [],
    reactions: [],
    requests: [],
    failures: [],
    authHeaders: new Set(),
    nextComment: 1,
  };

  const fail = (op) => {
    const i = state.failures.findIndex((f) => f.op === op);
    if (i < 0) return undefined;
    const f = state.failures[i];
    if (--f.times <= 0) state.failures.splice(i, 1);
    return f;
  };

  const graphql = (req, res, body) => {
    const { query, variables } = JSON.parse(body.toString("utf8"));
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
    state.requests.push({ op, variables });
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== API_KEY) {
      return send(401, {
        errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR", userPresentableMessage: "You need to authenticate to access this operation." } }],
      });
    }
    const failure = fail(op);
    if (failure) {
      if (failure.status) return send(failure.status, { errors: [{ message: failure.message ?? "boom" }] });
      return send(200, { errors: [{ message: failure.message ?? "boom" }] });
    }
    switch (op) {
      case "Viewer":
        return send(200, { data: { viewer: { id: "bot-user", name: "OpenBee", email: "bot@example.com" } } });
      case "Issues": {
        const matching = state.issues.filter(
          (i) => variables.states.includes(i.state) && i.labels.includes(variables.label) && i.project && variables.projects.includes(i.project.name),
        );
        const conn = connection(matching, variables.first, variables.after);
        conn.nodes = conn.nodes.map(({ state: _s, labels: _l, comments, ...rest }) => ({
          ...rest,
          comments: connection(comments, variables.commentsFirst, null),
        }));
        return send(200, { data: { issues: conn } });
      }
      case "IssueComments": {
        const found = state.issues.find((i) => i.id === variables.issueId);
        return send(200, { data: { issue: { comments: connection(found.comments, variables.first, variables.after) } } });
      }
      case "IssueId": {
        const found = state.issues.find((i) => i.id === variables.id || i.identifier === variables.id);
        if (!found) return send(200, { data: null, errors: [{ message: "Entity not found: Issue" }] });
        return send(200, { data: { issue: { id: found.id } } });
      }
      case "CommentCreate": {
        const id = `posted-${state.nextComment++}`;
        state.comments.push({ id, ...variables });
        return send(200, { data: { commentCreate: { success: true, comment: { id } } } });
      }
      case "ReactionCreate":
        state.reactions.push(variables.input);
        return send(200, { data: { reactionCreate: { success: true, reaction: { id: "r1" } } } });
      case "FileUpload": {
        const n = state.uploads.length + 1;
        state.uploads.push({ ...variables, data: undefined });
        return send(200, {
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                assetUrl: `${state.url}/assets/uploaded-${n}`,
                uploadUrl: `${state.url}/put/${n}`,
                headers: [{ key: "x-amz-acl", value: "private" }],
              },
            },
          },
        });
      }
      default:
        return send(400, { errors: [{ message: `unknown op ${op}` }] });
    }
  };

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/graphql" && req.method === "POST") return graphql(req, res, body);
    if (req.url.startsWith("/assets/") && req.method === "GET") {
      state.authHeaders.add(req.headers.authorization);
      const asset = state.assets.get(req.url.slice("/assets/".length));
      if (!asset) {
        res.writeHead(404);
        return res.end("missing");
      }
      res.writeHead(200, asset.contentType ? { "Content-Type": asset.contentType } : {});
      return res.end(asset.data);
    }
    if (req.url.startsWith("/put/") && req.method === "PUT") {
      const n = Number(req.url.slice("/put/".length));
      Object.assign(state.uploads[n - 1], { data: body, headers: req.headers });
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  state.url = url;
  return {
    url,
    endpoint: `${url}/graphql`,
    assetPrefix: `${url}/assets/`,
    state,
    failNext(op, times = 1, extra = {}) {
      state.failures.push({ op, times, ...extra });
    },
    ops(op) {
      return state.requests.filter((r) => r.op === op);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
