import logging
import json
import httpx
import urllib.parse
import re
from typing import Dict, Any
from app.tools.registry import registry
from app.services.scraper_client import scraper_client

logger = logging.getLogger(__name__)

@registry.register(
    name="search_web",
    description="Perform a web search using DuckDuckGo. Returns results with titles, URLs, and snippets.",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query."},
            "limit": {
                "type": "integer",
                "description": "Maximum number of results to return (default: 5).",
            },
        },
        "required": ["query"],
    }
)
async def search_web(query: str, limit: int = 5) -> str:
    """Search the web using DuckDuckGo via scraper-service."""
    logger.info(f"[WebTools] Python search_web called with query: {query}")
    try:
        items = await scraper_client.collect("duckduckgo", {"query": query, "limit": limit})
        results = []
        for item in items:
            results.append({
                "title": item.get("title", "No Title"),
                "url": item.get("url", ""),
                "snippet": item.get("snippet", item.get("description", ""))
            })
        return json.dumps({
            "status": "success",
            "query": query,
            "results": results
        })
    except Exception as e:
        logger.error(f"[WebTools] search_web error: {e}", exc_info=True)
        return json.dumps({
            "status": "error",
            "query": query,
            "results": [],
            "message": str(e)
        })

@registry.register(
    name="web_search",
    description="Perform a web search using DuckDuckGo. Returns results with titles, URLs, and snippets.",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query."},
            "limit": {
                "type": "integer",
                "description": "Maximum number of results to return (default: 5).",
            },
        },
        "required": ["query"],
    }
)
async def web_search(query: str, limit: int = 5) -> str:
    """Alias for search_web."""
    return await search_web(query, limit)

@registry.register(
    name="scrape_url",
    description="Scrape the main text content from a URL.",
    parameters={
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "The URL to scrape."}
        },
        "required": ["url"],
    }
)
async def scrape_url(url: str) -> str:
    """Scrape text content from a URL via scraper-service."""
    logger.info(f"[WebTools] Python scrape_url called with url: {url}")
    try:
        data = await scraper_client.scrape(url, engine="http")
        if data and data.get("success"):
            return json.dumps({
                "status": "success",
                "url": url,
                "content": data.get("content", "")[:8000]
            })
        return json.dumps({
            "status": "error",
            "url": url,
            "message": data.get("error", "Unknown scrape failure") if data else "Null response"
        })
    except Exception as e:
        logger.error(f"[WebTools] scrape_url error: {e}", exc_info=True)
        return json.dumps({
            "status": "error",
            "url": url,
            "message": str(e)
        })

async def hermes_web_research(query: str) -> str:
    # Fallback/compatibility definition
    res = await search_web(query)
    return str(res)

@registry.register(
    name="canvas_add_widget",
    description="Add a pre-built smart widget (Lego block) to the dashboard. The frontend already has the logic, you just configure the starting state.",
    parameters={
        "type": "object",
        "properties": {
            "widget_type": {"type": "string"},
            "widget_id": {"type": "string"},
            "config": {"type": "object"}
        },
        "required": ["widget_type"]
    }
)
async def canvas_add_widget(widget_type: str, config: Dict[str, Any] = None, widget_id: str = "") -> str:
    """Dummy handler for widget addition - intercepted by frontend"""
    return json.dumps({
        "success": True,
        "message": f"Widget {widget_type} queued for injection."
    })

@registry.register(
    name="html_notes_youtube_search",
    description="Search YouTube for videos. Returns video titles and IDs.",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query"},
            "limit": {"type": "integer", "description": "Maximum number of results to return", "default": 5}
        },
        "required": ["query"]
    }
)
async def html_notes_youtube_search(query: str, limit: int = 5) -> str:
    """Search YouTube and return a list of video dicts containing video_id and title."""
    try:
        url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
            html = resp.text
            matches = re.findall(r'"videoRenderer":\{.*?"videoId":"([a-zA-Z0-9_-]{11})",.*?"title":\{"runs":\[\{"text":"(.*?)"\}\]\}', html)
            results = []
            seen = set()
            for vid, title in matches:
                if vid not in seen:
                    seen.add(vid)
                    try:
                        clean_title = json.loads('"' + title + '"')
                    except Exception:
                        clean_title = title.replace('\\"', '"')
                    results.append({"video_id": vid, "title": clean_title})
                if len(results) >= limit:
                    break
            return json.dumps({"results": results, "count": len(results)})
    except Exception as e:
        logger.error(f"YouTube search error: {e}")
        return json.dumps({"error": str(e), "results": []})
