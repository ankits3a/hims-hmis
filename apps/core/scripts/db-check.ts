import { Client } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev";
  const client = new Client({ connectionString: url });
  await client.connect();
  const res = await client.query("select version()");
  // eslint-disable-next-line no-console
  console.log(res.rows[0].version);
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
