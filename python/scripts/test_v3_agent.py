import asyncio
from app.v3.orchestrator import run_v3_pipeline

async def main():
    res = await run_v3_pipeline("AAPL", trigger_type="test")
    print(res)

if __name__ == "__main__":
    asyncio.run(main())
