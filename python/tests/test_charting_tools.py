import pytest
import os
import json
import pandas as pd
from unittest.mock import patch, MagicMock
from app.tools.charting_tools import save_trading_chart, OUTPUT_DIR

@pytest.fixture
def mock_fetch_data():
    with patch("app.tools.charting_tools.fetch_data") as mock_fetch:
        # Create a mock DataFrame with necessary columns
        dates = pd.date_range(start="2026-03-01", periods=10, freq="D")
        df = pd.DataFrame({
            "Open": [50.0] * 10,
            "High": [55.0] * 10,
            "Low": [45.0] * 10,
            "Close": [52.0] * 10,
            "Volume": [10000] * 10,
            "EMA_20": [51.0] * 10,
            "EMA_50": [50.5] * 10
        }, index=dates)
        df.index.name = "Date"
        mock_fetch.return_value = df
        yield mock_fetch

@pytest.mark.asyncio
async def test_save_trading_chart_generates_json_and_html(mock_fetch_data):
    # Prepare dummy overlays
    overlays = [
        {
            "type": "support",
            "y0": 45.45,
            "y1": 47.43,
            "color": "green",
            "reasoning": "Strong support"
        },
        {
            "type": "resistance",
            "y0": 53.0,
            "y1": 54.8,
            "color": "red",
            "reasoning": "Strong resistance"
        }
    ]
    
    ticker = "TEST"
    
    # Run the save_trading_chart function
    result = await save_trading_chart(ticker=ticker, overlays=overlays, period="3mo")
    
    assert "Successfully generated" in result
    
    # Verify JSON file exists and contains correct content
    json_path = os.path.join(OUTPUT_DIR, f"{ticker}.json")
    assert os.path.exists(json_path)
    
    try:
        with open(json_path, "r") as f:
            data = json.load(f)
        
        assert data["symbol"] == ticker
        assert "latest_analysis" in data
        assert data["latest_analysis"]["status"] == "success"
        assert len(data["latest_analysis"]["overlays"]) == 2
        assert data["latest_analysis"]["overlays"][0]["type"] == "support"
    finally:
        # Clean up files generated during test
        if os.path.exists(json_path):
            os.remove(json_path)
        
        # Clean up HTML file if created (it will have a timestamp in its name)
        filename = data["latest_analysis"]["filename"]
        html_path = os.path.join(OUTPUT_DIR, filename)
        if os.path.exists(html_path):
            os.remove(html_path)
