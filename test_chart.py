import asyncio
import traceback
from app.tools.charting_tools import generate_trading_chart

async def main():
    try:
        result = await generate_trading_chart("LTM", iterations=1, period="3mo")
        print("RESULT:", result)
    except Exception as e:
        print("ERROR:", traceback.format_exc())

if __name__ == "__main__":
    asyncio.run(main())
