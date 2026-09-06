// Real RSS shapes, trimmed. Captured 2026-09-05 from the live feeds so the
// parser is tested against what the publishers actually emit — CDATA, a
// <source url> element, media:content vs media:thumbnail, and Google's
// " - Publisher" title suffix — rather than against tidy invented XML.

export const GOOGLE_TOP = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Top stories - Google News</title>
<item><title>U.S. military says it hit 3 Iranian tankers after Navy ships targeted - The Washington Post</title>
<link>https://news.google.com/rss/articles/CBMiaAFBVV95cUxOd0ZBQmM?oc=5</link>
<pubDate>Sat, 05 Sep 2026 22:10:00 GMT</pubDate>
<source url="https://www.washingtonpost.com">The Washington Post</source></item>
<item><title>Trump envoys Witkoff and Kushner meet with Putin about ending the Ukraine war - Axios</title>
<link>https://news.google.com/rss/articles/CBMiZ2h0dHBzOi8vd3d3LmF4aW9z?oc=5</link>
<pubDate>Sat, 05 Sep 2026 21:40:00 GMT</pubDate>
<source url="https://www.axios.com">Axios</source></item>
<item><title>Scoop: Republican midterms convention speakers revealed - Axios</title>
<link>https://news.google.com/rss/articles/CBMiQXNjb29wLXJlcHVi?oc=5</link>
<pubDate>Sat, 05 Sep 2026 20:05:00 GMT</pubDate>
<source url="https://www.axios.com">Axios</source></item>
</channel></rss>`;

export const GOOGLE_WORLD = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>World - Google News</title>
<item><title>Chinese national rescued from Nepal tunnel 10 days after flash flood - Reuters</title>
<link>https://news.google.com/rss/articles/CBMibmh0dHBzOi8vcmV1?oc=5</link>
<pubDate>Sat, 05 Sep 2026 19:00:00 GMT</pubDate>
<source url="https://www.reuters.com">Reuters</source></item>
<item><title>U.S. military says it hit 3 Iranian tankers after Navy ships targeted - The Washington Post</title>
<link>https://news.google.com/rss/articles/CBMiaAFBVV95cUxOd0ZBQmM?oc=5</link>
<pubDate>Sat, 05 Sep 2026 22:10:00 GMT</pubDate>
<source url="https://www.washingtonpost.com">The Washington Post</source></item>
</channel></rss>`;

// NYT: real article URL, media:content, CDATA description.
export const NYT = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title>U.S. Strikes Three Iranian 'Shadow Network' Oil Tankers, Military Says</title>
<link>https://www.nytimes.com/2026/09/05/us/politics/iran-tankers-strike.html</link>
<description><![CDATA[The strikes came hours after missiles were fired at two Navy destroyers.]]></description>
<pubDate>Sat, 05 Sep 2026 22:31:00 +0000</pubDate>
<media:content url="https://static01.nyt.com/images/2026/09/05/tankers.jpg" medium="image" height="600" width="900"/>
</item>
<item><title>Putin Meets Witkoff and Kushner in Moscow to Discuss Ukraine War</title>
<link>https://www.nytimes.com/2026/09/05/world/europe/putin-witkoff-kushner.html</link>
<description>A four-hour session at the Kremlin.</description>
<pubDate>Sat, 05 Sep 2026 21:55:00 +0000</pubDate>
<media:content url="https://static01.nyt.com/images/2026/09/05/moscow.jpg" medium="image"/>
</item>
</channel></rss>`;

// BBC: media:thumbnail rather than media:content.
export const BBC = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title><![CDATA[US envoys set for Ukraine talks after meeting Putin in Moscow]]></title>
<link>https://www.bbc.com/news/articles/c1abc2def3g</link>
<description><![CDATA[Steve Witkoff and Jared Kushner spent four hours with the Russian president.]]></description>
<pubDate>Sat, 05 Sep 2026 22:02:11 GMT</pubDate>
<media:thumbnail width="640" height="360" url="https://ichef.bbci.co.uk/news/640/moscow.jpg"/>
</item>
</channel></rss>`;

// A feed with nothing in common with the others — the negative case.
export const LOCAL = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>10,000 Maniacs perform at Reg Lenna Center for 45th anniversary show</title>
<link>https://buffalonews.com/entertainment/maniacs.html</link>
<pubDate>Sat, 05 Sep 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;
