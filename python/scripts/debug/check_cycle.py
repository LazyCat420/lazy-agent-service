import os
import psycopg

DATABASE_URL = os.environ["DATABASE_URL"]

with psycopg.connect(DATABASE_URL) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM pipeline_state LIMIT 1;")
        print("Pipeline State:")
        colnames = [desc[0] for desc in cur.description]
        row = cur.fetchone()
        if row:
            for c, v in zip(colnames, row):
                print(f"  {c}: {v}")
