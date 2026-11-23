// Creates or updates the database tables. Safe to run any number of times.
//   npm run db:migrate
import { readFile } from "node:fs/promises";
import { connect } from "./db.mjs";

const sql = connect();
const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
await sql.unsafe(schema);
const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
console.log("Database ready:", tables.map(t => t.table_name).join(", "));
await sql.end();
