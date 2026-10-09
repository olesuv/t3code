import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN workspace_json TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN workspace_file_path TEXT`;
  yield* sql`
    CREATE INDEX idx_projection_projects_workspace_file
    ON projection_projects(workspace_file_path, deleted_at)
  `;
});
