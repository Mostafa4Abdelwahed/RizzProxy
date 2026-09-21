import concurrent.futures
import json
import os
import re
import sys
import urllib.request

BASE_URL = "https://poki.com"
SITEMAP_URL = "https://poki.com/en/sitemaps/games.xml"
IMAGE_HOST = "https://img.poki-cdn.com/"
OUTPUT_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "static",
    "public",
    "games",
    "games.json",
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

JSONLD_RE = re.compile(
    r'<script type="application/ld\+json" id="game-json-ld">(.*?)</script>', re.S
)
# The game page embeds the Poki player wrapper URL as an escaped JSON string.
# It can be absolute (https:\u002F\u002F...) or protocol-relative (\u002F\u002F...).
CONTENT_RE = re.compile(r'\\"content\\":\\"([^"]*)\\"')
# The wrapper page embeds the real playable game URL (on *.gdn.poki.com).
GAMEURI_RE = re.compile(r'"gameUri":"([^"]+)"')

MAX_WORKERS = 24
RETRIES = 3


def fetch(url, referer=None):
    last_error = None
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    for _ in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.read().decode("utf-8", "replace")
        except Exception as err:  # noqa: BLE001
            last_error = err
    raise last_error


def find_game_node(node):
    if isinstance(node, dict):
        if "url" in node and "image" in node and "name" in node:
            return node
        for value in node.values():
            found = find_game_node(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = find_game_node(value)
            if found:
                return found
    return None


def parse_game_page(html):
    match = JSONLD_RE.search(html)
    if not match:
        return None
    node = find_game_node(json.loads(match.group(1)))
    if not node:
        return None

    image = node["image"]
    if isinstance(image, dict):
        image = image.get("@id")
    if not image or not image.startswith(IMAGE_HOST):
        return None

    content_match = CONTENT_RE.search(html)
    content_url = None
    if content_match:
        content_url = content_match.group(1).replace("\\u002F", "/")
        if content_url.startswith("//"):
            content_url = "https:" + content_url

    return {
        "name": node["name"],
        "portal": node["url"],
        "image": image[len(IMAGE_HOST):],
        "content": content_url,
    }


def resolve_game_url(game):
    content = game["content"]
    if not content:
        return game["portal"]
    if "gdn.poki.com" in content:
        return content
    try:
        wrapper = fetch(content, referer="https://poki.com/")
    except Exception:  # noqa: BLE001
        return game["portal"]
    match = GAMEURI_RE.search(wrapper)
    if match:
        return match.group(1)
    return game["portal"]


def scrape(url):
    try:
        game = parse_game_page(fetch(url))
        if not game:
            print("SKIP " + url + " (no game data)")
            return None
        game["url"] = resolve_game_url(game)
        game.pop("content", None)
        game.pop("portal", None)
        print("OK   " + game["name"])
        return game
    except Exception as err:  # noqa: BLE001
        print("FAIL " + url + " (" + str(err) + ")")
        return None


def get_game_urls():
    xml = fetch(SITEMAP_URL)
    urls = re.findall(r"<loc>(.*?)</loc>", xml)
    return [u for u in urls if "/en/g/" in u]


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None

    urls = get_game_urls()
    if limit:
        urls = urls[:limit]
    print("Scraping " + str(len(urls)) + " games from Poki...")

    games = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for game in pool.map(scrape, urls):
            if game:
                games.append(game)

    games.sort(key=lambda g: g["name"].lower())

    out_path = os.path.abspath(OUTPUT_FILE)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(games, f)

    print("Wrote " + str(len(games)) + " games to " + out_path)


if __name__ == "__main__":
    main()
