import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  yield* SqlClient.SqlClient;
});
