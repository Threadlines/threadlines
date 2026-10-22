// Test-only driver (untracked): sets Test PC to ask first.
import { WsRpcGroup } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { readFileSync } from "node:fs";

const [tokenA, tokenB] = readFileSync(process.argv[2]!, "utf8").trim().split("\n");
const A = { http: "http://127.0.0.1:14622", token: tokenA!, env: "cb58784c-5e23-4741-b61c-46916d1ae080" };
const B = { http: "http://127.0.0.1:14791", token: tokenB!, env: "c8d4f232-4e3d-47d5-9e57-9a1dcf4a1dc1" };
const wsUrl = async (s: typeof A) => {
  const res = await fetch(`${s.http}/api/auth/ws-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}` },
  });
  return `${s.http.replace("http", "ws")}/ws?wsToken=${((await res.json()) as { token: string }).token}`;
};
const call = async (s: typeof A, f: (c: any) => Effect.Effect<any, any, any>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* f(yield* RpcClient.make(WsRpcGroup));
      }),
    ).pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(await wsUrl(s))),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
    ) as Effect.Effect<any, any, never>,
  );
// Test-only (untracked): Test PC asks first before the Mac's agents start work on it.
const list = await call(B, (c) => c["links.list"]({}));
for (const inbound of list.inbound) {
  const updated = await call(B, (c) => c["links.setAccess"]({ deviceId: inbound.deviceId, access: "ask" }));
  console.log("B inbound access", updated.access);
}
process.exit(0);
