#!/usr/bin/env python3
"""CPC 分类号数据下载脚本（异步并发版）

从 https://lake.patentfun.cn/api/classifications 下载 CPC 分类号数据，
保存到本地 Redis Hash 中。

用法:
    python scripts/sync-cpc-to-redis.py [--max-pages N] [--batch-size N] [--concurrency N]

环境变量:
    REDIS_HOST: Redis 主机地址 (默认: localhost)
    REDIS_PORT: Redis 端口 (默认: 6379)
    REDIS_DB: Redis 数据库编号 (默认: 0)
    AUTH_COOKIE: 认证 Cookie
"""

import argparse
import asyncio
import json
import os
import sys
import time
from typing import Optional

import redis
import aiohttp


def get_redis_client() -> redis.Redis:
    return redis.Redis(
        host=os.environ.get("REDIS_HOST", "localhost"),
        port=int(os.environ.get("REDIS_PORT", 6379)),
        db=int(os.environ.get("REDIS_DB", 0)),
        decode_responses=True,
    )


async def fetch_page(
    session: aiohttp.ClientSession,
    page: int,
    limit: int,
    cookie: str,
    semaphore: asyncio.Semaphore,
    retry: int = 3,
) -> Optional[dict]:
    url = "https://lake.patentfun.cn/api/classifications"
    params = {"type": "cpc", "page": str(page), "limit": str(limit)}
    headers = {
        "Accept": "application/json",
        "Referer": "https://lake.patentfun.cn/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }

    async with semaphore:
        for attempt in range(retry):
            try:
                async with session.get(
                    url, params=params, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
                ) as resp:
                    resp.raise_for_status()
                    return await resp.json()
            except Exception as e:
                if attempt < retry - 1:
                    await asyncio.sleep(1 * (attempt + 1))
                else:
                    print(f"[ERROR] 第 {page} 页请求失败 (重试 {retry} 次): {e}")
                    return None
    return None


async def sync_cpc_to_redis(
    cookie: str,
    max_pages: Optional[int] = None,
    batch_size: int = 20,
    redis_key: str = "classifications:cpc",
    concurrency: int = 50,
):
    client = get_redis_client()
    try:
        client.ping()
        print(f"[INFO] Redis 连接成功")
    except redis.ConnectionError as e:
        print(f"[ERROR] Redis 连接失败: {e}")
        sys.exit(1)

    cookie_val = cookie.split("=", 1)[-1] if "=" in cookie else cookie
    connector = aiohttp.TCPConnector(limit=concurrency, force_close=False)
    async with aiohttp.ClientSession(
        connector=connector,
        cookie_jar=aiohttp.CookieJar(),
    ) as session:
        session.cookie_jar.update_cookies({"patent-etl-session": cookie_val})

        print("[INFO] 正在获取第 1 页...")
        semaphore = asyncio.Semaphore(concurrency)
        first_page = await fetch_page(session, 1, batch_size, cookie_val, semaphore)
        if not first_page or not first_page.get("success"):
            print("[ERROR] 获取第一页失败")
            sys.exit(1)

        api_data = first_page.get("data", {})
        total_items = api_data.get("total", 0)
        total_pages = api_data.get("total_pages", 0)

        if max_pages:
            total_pages = min(total_pages, max_pages)

        print(f"[INFO] 总数据量: {total_items}, 总页数: {total_pages}, 并发数: {concurrency}")

        if client.exists(redis_key):
            print(f"[WARN] Redis Key '{redis_key}' 已存在，将被覆盖")
            client.delete(redis_key)

        items = api_data.get("items", [])
        buffer = {}
        for item in items:
            code_norm = item.get("code_norm")
            if code_norm:
                buffer[code_norm] = json.dumps(item, ensure_ascii=False)
        if buffer:
            client.hset(redis_key, mapping=buffer)

        total_synced = len(buffer)
        start_time = time.time()
        print(f"[INFO] 第 1 页完成，累计 {total_synced} 条")

        page_numbers = list(range(2, total_pages + 1))
        completed = 0
        write_buffer = {}
        write_lock = asyncio.Lock()
        flush_threshold = 500
        last_progress_time = start_time

        async def worker(page: int):
            nonlocal total_synced, completed, last_progress_time
            data = await fetch_page(session, page, batch_size, cookie_val, semaphore)
            async with write_lock:
                completed += 1
                if data and data.get("success"):
                    for item in data.get("data", {}).get("items", []):
                        code_norm = item.get("code_norm")
                        if code_norm:
                            write_buffer[code_norm] = json.dumps(item, ensure_ascii=False)
                    total_synced += len(data.get("data", {}).get("items", []))

                if len(write_buffer) >= flush_threshold or completed == total_pages - 1:
                    if write_buffer:
                        client.hset(redis_key, mapping=write_buffer)
                        write_buffer.clear()

                elapsed = time.time() - start_time
                if completed % 500 == 0 or completed == total_pages - 1:
                    speed = completed / elapsed if elapsed > 0 else 0
                    eta = (total_pages - completed) / speed if speed > 0 else 0
                    print(
                        f"[PROGRESS] {completed}/{total_pages - 1} 页 "
                        f"({completed/(total_pages-1)*100:.1f}%), "
                        f"累计 {total_synced} 条, "
                        f"速度 {speed:.1f} 页/秒, "
                        f"预计剩余 {eta/60:.1f} 分钟"
                    )

        tasks = [asyncio.create_task(worker(p)) for p in page_numbers]
        await asyncio.gather(*tasks)

        if write_buffer:
            client.hset(redis_key, mapping=write_buffer)
            write_buffer.clear()

    elapsed = time.time() - start_time
    redis_count = client.hlen(redis_key)
    print(f"\n[SUCCESS] 完成！")
    print(f"[INFO] 总耗时: {elapsed/60:.1f} 分钟")
    print(f"[INFO] Redis 数据量: {redis_count} 条")
    print(f"[INFO] Redis Key: {redis_key}")

    if redis_count > 0:
        sample_key = client.hkeys(redis_key)[0]
        sample_data = json.loads(client.hget(redis_key, sample_key))
        print(f"[INFO] 示例数据 ({sample_key}): {sample_data.get('title_zh', 'N/A')}")

    client.close()


def main():
    parser = argparse.ArgumentParser(description="同步 CPC 分类号数据到 Redis（异步并发版）")
    parser.add_argument("--max-pages", type=int, default=None, help="最大页数（测试用）")
    parser.add_argument("--batch-size", type=int, default=20, help="每页条数（默认 20）")
    parser.add_argument("--redis-key", type=str, default="classifications:cpc", help="Redis Hash 键名")
    parser.add_argument("--concurrency", type=int, default=50, help="并发数（默认 50）")

    args = parser.parse_args()

    cookie = os.environ.get("AUTH_COOKIE", "")
    if not cookie:
        print("[ERROR] 未设置 AUTH_COOKIE 环境变量")
        sys.exit(1)

    asyncio.run(
        sync_cpc_to_redis(
            cookie=cookie,
            max_pages=args.max_pages,
            batch_size=args.batch_size,
            redis_key=args.redis_key,
            concurrency=args.concurrency,
        )
    )


if __name__ == "__main__":
    main()
