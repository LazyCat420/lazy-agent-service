import logging
import json
import aiohttp
from app.tools.registry import registry
from app.config.config import settings

logger = logging.getLogger(__name__)

async def search_tavily(query: str, max_results: int) -> list[dict]:
    if not settings.TAVILY_API_KEY:
        raise ValueError("TAVILY_API_KEY not set")
    url = "https://api.tavily.com/search"
    payload = {
        "api_key": settings.TAVILY_API_KEY,
        "query": query,
        "search_depth": "basic",
        "include_answer": False,
        "include_images": False,
        "include_raw_content": False,
        "max_results": max_results,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload, timeout=10) as response:
            if response.status != 200:
                raise Exception(f"Tavily returned {response.status}: {await response.text()}")
            data = await response.json()
            return [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")} for r in data.get("results", [])]

async def search_exa(query: str, max_results: int) -> list[dict]:
    if not settings.EXA_API_KEY:
        raise ValueError("EXA_API_KEY not set")
    url = "https://api.exa.ai/search"
    headers = {
        "x-api-key": settings.EXA_API_KEY,
        "content-type": "application/json"
    }
    payload = {
        "query": query,
        "useAutoprompt": True,
        "numResults": max_results
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload, headers=headers, timeout=10) as response:
            if response.status != 200:
                raise Exception(f"Exa returned {response.status}: {await response.text()}")
            data = await response.json()
            return [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("text", "") or r.get("snippet", "")} for r in data.get("results", [])]

async def search_bing(query: str, max_results: int) -> list[dict]:
    if not settings.BING_API_KEY:
        raise ValueError("BING_API_KEY not set")
    url = "https://api.bing.microsoft.com/v7.0/search"
    headers = {"Ocp-Apim-Subscription-Key": settings.BING_API_KEY}
    params = {"q": query, "count": max_results}
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params, timeout=10) as response:
            if response.status != 200:
                raise Exception(f"Bing returned {response.status}: {await response.text()}")
            data = await response.json()
            return [{"title": r.get("name", ""), "url": r.get("url", ""), "snippet": r.get("snippet", "")} for r in data.get("webPages", {}).get("value", [])]

async def search_google(query: str, max_results: int) -> list[dict]:
    if not settings.GOOGLE_SEARCH_API_KEY or not settings.GOOGLE_SEARCH_CX:
        raise ValueError("Google API key or CX not set")
    url = "https://www.googleapis.com/customsearch/v1"
    params = {
        "key": settings.GOOGLE_SEARCH_API_KEY,
        "cx": settings.GOOGLE_SEARCH_CX,
        "q": query,
        "num": min(max_results, 10)
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(url, params=params, timeout=10) as response:
            if response.status != 200:
                raise Exception(f"Google returned {response.status}: {await response.text()}")
            data = await response.json()
            return [{"title": r.get("title", ""), "url": r.get("link", ""), "snippet": r.get("snippet", "")} for r in data.get("items", [])]

@registry.register(
    name="lazy_web_search",
    description="Search the web for real-time information using a fallback mechanism across multiple providers.",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query."},
            "max_results": {"type": "integer", "description": "Maximum number of results to return.", "default": 5}
        },
        "required": ["query"],
    }
)
async def lazy_web_search(query: str, max_results: int = 5) -> str:
    logger.info(f"[SearchTools] lazy_web_search called with query: {query}")
    
    providers = [
        ("Tavily", search_tavily),
        ("Exa", search_exa),
        ("Bing", search_bing),
        ("Google", search_google)
    ]
    
    errors = []
    
    for name, search_func in providers:
        try:
            logger.info(f"[SearchTools] Attempting search with {name}")
            results = await search_func(query, max_results)
            logger.info(f"[SearchTools] {name} search succeeded with {len(results)} results")
            return json.dumps({
                "status": "success",
                "provider": name,
                "query": query,
                "results": results
            })
        except Exception as e:
            msg = str(e)
            logger.warning(f"[SearchTools] {name} search failed or skipped: {msg}")
            errors.append(f"{name}: {msg}")
            
    # If all fail
    logger.error(f"[SearchTools] All web search providers failed. Errors: {errors}")
    return json.dumps({
        "status": "error",
        "query": query,
        "message": "All configured search providers failed or were not configured.",
        "details": errors
    })
