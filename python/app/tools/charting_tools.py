import os
import json
import asyncio
import datetime
import urllib.request
import urllib.parse
import aiohttp
import pandas as pd
import yfinance as yf
from pydantic import BaseModel, Field
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from app.tools.registry import registry

VLLM_ENDPOINT = os.getenv("DGX_SPARK_VLLM_URL", "http://10.0.0.141:8000")
if not VLLM_ENDPOINT.endswith("/v1/chat/completions"):
    VLLM_ENDPOINT = f"{VLLM_ENDPOINT.rstrip('/')}/v1/chat/completions"

def get_model_name(endpoint):
    base = endpoint.replace("/v1/chat/completions", "")
    try:
        req = urllib.request.Request(f"{base}/v1/models")
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            if data and "data" in data and len(data["data"]) > 0:
                return data["data"][0]["id"]
    except Exception as e:
        print(f"Warning: Failed to fetch dynamic model from {base}: {e}")
    return "Qwen/Qwen3.5-122B-A10B-FP8"

MODEL_NAME = get_model_name(VLLM_ENDPOINT)
OUTPUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../data/charts"))

class ChartingInput(BaseModel):
    ticker: str = Field(description="The stock ticker symbol (e.g. AAPL)")
    iterations: int = Field(default=1, description="Number of LLM reasoning iterations to build the chart (default 1)")
    period: str = Field(default="3mo", description="Timeframe of historical data to fetch (e.g., '1mo', '3mo', '6mo', '1y')")


def fetch_data(symbol, period="3mo"):
    df = yf.Ticker(symbol).history(period=period)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) == 0:
        raise Exception(f"No data found for {symbol}")
    df['EMA_20'] = df['Close'].ewm(span=20, adjust=False).mean()
    df['EMA_50'] = df['Close'].ewm(span=50, adjust=False).mean()
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    return df


def build_iteration_prompt(symbol, data_str, iteration, prev_specs, period):
    base = f"""You are an elite quantitative technical analyst.
I am giving you the OHLCV data for {symbol} over the last {period}.

Analyze the data and produce a JSON overlay specification:
1. Support / Trendlines (kind: "line")
2. Resistance lines (kind: "line")
3. Demand / Supply zones (kind: "zone")
4. Liquidity voids — areas where price moved fast on low volume (kind: "volume_void")
5. Use quant equations (Z-score, RSI, ATR, Bollinger Bands, Fibonacci) in your reasoning.

Output ONLY raw JSON matching this schema — no markdown, no explanation outside the JSON:
{{
  "overlays": [
    {{"kind":"line","x0":"YYYY-MM-DD","y0":float,"x1":"YYYY-MM-DD","y1":float,"color":"green","label":"str"}},
    {{"kind":"zone","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"blue","label":"str"}},
    {{"kind":"volume_void","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"purple","label":"str"}}
  ],
  "strategy_name": "A short name for your strategy approach",
  "analysis": "2-3 sentence explanation.",
  "confidence": 0.0-1.0
}}
"""
    if iteration > 1 and prev_specs:
        history_block = "\n\n--- PREVIOUS ITERATIONS (your earlier work) ---\n"
        for prev in prev_specs:
            history_block += f"\nIteration {prev['iteration']} (strategy: {prev.get('strategy_name','unknown')}, confidence: {prev.get('confidence','?')}):\n"
            history_block += f"  Analysis: {prev.get('analysis','')}\n"
            history_block += f"  Overlays: {json.dumps(prev.get('overlays',[]), indent=2)}\n"
        history_block += "\n--- END PREVIOUS ITERATIONS ---\n"
        history_block += f"\nThis is iteration {iteration}. Review your previous work above."
        history_block += "\nIdentify weaknesses or missed patterns. Try a DIFFERENT strategy approach."
        history_block += "\nYou must IMPROVE on your previous analysis — do not repeat the same thing.\n"
        base += history_block

    base += f"\nHere is the data:\n{data_str}\n"
    return base


async def ask_llm(session, df, symbol, iteration=1, prev_specs=None, period="3mo"):
    # Pass all rows from df, no artificial 30 day limit if they requested more
    data_str = "Date | Open | High | Low | Close | Volume\n"
    for date, row in df.iterrows():
        ds = date.strftime('%Y-%m-%d')
        data_str += f"{ds} | {row['Open']:.2f} | {row['High']:.2f} | {row['Low']:.2f} | {row['Close']:.2f} | {row['Volume']}\n"

    prompt = build_iteration_prompt(symbol, data_str, iteration, prev_specs or [], period)

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": "You are a quant assistant that outputs strict JSON."},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 4000,
        "temperature": 0.3 if iteration > 1 else 0.1
    }

    async with session.post(VLLM_ENDPOINT, json=payload, timeout=300) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise Exception(f"LLM API Error {resp.status}: {text}")
        result = await resp.json()
        msg = result["choices"][0]["message"]
        content = msg.get("content") or ""

        reasoning = msg.get("reasoning_content") or ""
        if not reasoning and "<think>" in content:
            try:
                s = content.find("<think>") + 7
                e = content.find("</think>")
                reasoning = content[s:e].strip()
            except:
                pass
        if not reasoning:
            try:
                reasoning = content[:content.find('{')].strip()
            except:
                pass

        clean = content.replace('```json', '').replace('```', '').strip()
        si = clean.find('{')
        ei = clean.rfind('}') + 1
        if si != -1 and ei > si:
            clean = clean[si:ei]
        spec = json.loads(clean)
        return spec, reasoning


def render_chart(df, spec, symbol, iteration=1):
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True,
                        vertical_spacing=0.03,
                        subplot_titles=(f"{symbol} · Iteration {iteration}", "Volume"),
                        row_width=[0.2, 0.7])

    fig.add_trace(go.Candlestick(x=df.index, open=df['Open'], high=df['High'],
                                  low=df['Low'], close=df['Close'], name="Price"), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_20'], line=dict(color='orange', width=1.5), name='EMA 20'), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_50'], line=dict(color='purple', width=1.5), name='EMA 50'), row=1, col=1)

    colors = ['green' if row['Close'] >= row['Open'] else 'red' for _, row in df.iterrows()]
    fig.add_trace(go.Bar(x=df.index, y=df['Volume'], marker_color=colors, name="Volume"), row=2, col=1)

    for ov in spec.get("overlays", []):
        kind = ov.get("kind")
        if kind == "line":
            fig.add_shape(type="line", x0=ov["x0"], y0=ov["y0"], x1=ov["x1"], y1=ov["y1"],
                          line=dict(color=ov.get("color","white"), width=2, dash="dashdot"), row=1, col=1)
            fig.add_annotation(x=ov["x1"], y=ov["y1"], text=ov.get("label",""), showarrow=False,
                               yshift=10, font=dict(color=ov.get("color","white")), row=1, col=1)
        elif kind in ("zone", "volume_void"):
            is_void = kind == "volume_void"
            fc = ov.get("color", "purple" if is_void else "blue")
            fig.add_shape(type="rect", x0=ov["x0"], y0=ov["y0"], x1=ov["x1"], y1=ov["y1"],
                          line=dict(color=fc, width=1 if is_void else 0, dash="dot" if is_void else "solid"),
                          fillcolor=fc, opacity=0.3 if is_void else 0.2, row=1, col=1)
            fig.add_annotation(x=ov["x0"], y=ov["y1"], text=ov.get("label",""), showarrow=False,
                               yshift=10, font=dict(color=ov.get("color","white")), row=1, col=1)

    strat = spec.get("strategy_name", "")
    conf = spec.get("confidence", "")
    fig.update_layout(
        title=f"{symbol} · {strat} (confidence: {conf})<br><sup>{spec.get('analysis','')}</sup>",
        template='plotly_dark', xaxis_rangeslider_visible=False, height=800)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    filename = f"{symbol}_{int(datetime.datetime.now().timestamp())}.html"
    out = os.path.join(OUTPUT_DIR, filename)
    fig.write_html(out)
    return filename


@registry.register(
    name="generate_trading_chart",
    description="Generate an interactive HTML technical analysis chart for a stock using LLM quant strategies.",
    parameters={
        "type": "object",
        "properties": {
            "ticker": {"type": "string", "description": "The stock ticker symbol"},
            "iterations": {"type": "integer", "description": "Number of self-reflection iterations (default 1)"},
            "period": {"type": "string", "description": "Timeframe of historical data to fetch (e.g., '1mo', '3mo', '6mo', '1y')"}
        },
        "required": ["ticker"],
    },
    tier=1,
    source="llm_agent",
    input_model=ChartingInput,
)
async def generate_trading_chart(ticker: str, iterations: int = 1, period: str = "3mo") -> str:
    """Generates an agentic trading chart and returns the URL and analysis."""
    symbol = ticker.upper()
    df = await asyncio.to_thread(fetch_data, symbol, period)
    prev_specs = []

    async with aiohttp.ClientSession() as session:
        for i in range(1, iterations + 1):
            try:
                spec, reasoning = await ask_llm(session, df, symbol, i, prev_specs, period)
                filename = await asyncio.to_thread(render_chart, df, spec, symbol, i)

                entry = {
                    "iteration": i,
                    "strategy_name": spec.get("strategy_name", ""),
                    "confidence": spec.get("confidence", 0),
                    "analysis": spec.get("analysis", ""),
                    "reasoning": reasoning,
                    "overlays": spec.get("overlays", []),
                    "status": "success",
                    "filename": filename
                }
                prev_specs.append(entry)
            except Exception as e:
                return f"Failed to generate chart on iteration {i}: {str(e)}"

    latest = prev_specs[-1]
    chart_url = f"http://10.0.0.16:5591/charts/{latest['filename']}"
    
    # Save raw JSON for the frontend
    try:
        # Convert df index (dates) to string for JSON serialization
        df_json = df.reset_index()
        df_json['Date'] = df_json['Date'].dt.strftime('%Y-%m-%d')
        json_data = {
            "symbol": symbol,
            "period": period,
            "timestamp": int(datetime.datetime.now().timestamp()),
            "ohlcv": df_json[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']].to_dict(orient='records'),
            "ema_20": df_json['EMA_20'].fillna(0).tolist(),
            "ema_50": df_json['EMA_50'].fillna(0).tolist(),
            "latest_analysis": latest
        }
        json_path = os.path.join(OUTPUT_DIR, f"{symbol}.json")
        with open(json_path, 'w') as f:
            json.dump(json_data, f)
    except Exception as e:
        print(f"Error saving JSON chart data: {e}")

    
    result = f"Successfully generated trading chart for {symbol}.\n\n"
    result += f"**Chart URL**: {chart_url}\n"
    result += f"**Strategy**: {latest.get('strategy_name')}\n"
    result += f"**Confidence**: {latest.get('confidence')}\n"
    result += f"**Analysis**: {latest.get('analysis')}\n"
    
    return result
