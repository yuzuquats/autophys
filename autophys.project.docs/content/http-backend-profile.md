# Axum leads the browser API and ntex leads the large file on loopback

Autophys build `5ef73a1` ran the same application and prebuilt frontend on Actix Web 4.13.0, Axum 0.8.9, and ntex 2.18.0. The release binary included all three adapters and selected one at startup through `AUTOPHYS_WEB_BACKEND`.

The server had two i7-12700K P cores and two Tokio workers on yuzuquats. The native client ran on four separate P cores and reused HTTP/1.1 loopback connections. Each run warmed for 1.4 seconds and measured for 3 seconds. Three rounds rotated backend and route order. Each server used a fresh collection, SQLite store, and document-issued browser cookie. There were 32 concurrent connections for the JSON routes and 16 for the 1,053,386-byte JavaScript response. All 6,581,408 measured requests returned HTTP 200 and the expected body length.

Each row gives the median of three runs. Latency percentiles are calculated within each run and then summarized across runs. CPU time comes from the daemon's user and system process counters. RSS is the resident memory at the end of the measured interval.

| Route | Backend | req/s | p50 | p95 | p99 | CPU ms / 1k req | RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Health | Axum | 212,251 | 0.151 ms | 0.216 ms | 0.234 ms | 9.24 | 16.8 |
| Health | Actix Web | 218,179 | 0.145 ms | 0.157 ms | 0.170 ms | 9.18 | 18.1 |
| Health | ntex | 187,589 | 0.155 ms | 0.246 ms | 0.277 ms | 10.66 | 19.8 |
| Browser context | Axum | 48,117 | 0.654 ms | 1.089 ms | 1.460 ms | 41.01 | 20.4 |
| Browser context | Actix Web | 42,713 | 0.657 ms | 1.377 ms | 2.013 ms | 46.82 | 20.8 |
| Browser context | ntex | 45,789 | 0.621 ms | 1.359 ms | 1.919 ms | 43.46 | 20.9 |
| Main script | Axum | 373 | 42.04 ms | 44.04 ms | 46.03 ms | 2,080 | 20.2 |
| Main script | Actix Web | 366 | 42.96 ms | 49.08 ms | 58.00 ms | 1,989 | 22.4 |
| Main script | ntex | 733 | 18.75 ms | 36.99 ms | 46.34 ms | 2,434 | 20.6 |

Actix Web had the lowest health p95. Its health throughput varied from 189k to 225k req/s, overlapping Axum's 209k to 216k. Axum used the least CPU and had the lowest p95 on the authenticated context request.

The main script reached 375 MiB/s on Axum, 368 MiB/s on Actix Web, and 736 MiB/s on ntex. The ntex result varied from 497 to 892 MiB/s across rounds. Server CPU use for this transfer was below the two-core allocation on Axum and Actix Web, while both showed a roughly 42 ms median. A paired follow-up changed only the Linux client's ACK setting. Reasserting TCP_QUICKACK before each 64 KiB body read raised the two-run mean from 374 to 620 MiB/s on Axum and from 375 to 739 MiB/s on Actix Web. ntex ranged from 748 to 1,016 MiB/s on the control runs and 987 to 991 MiB/s with QUICKACK. This shows the file result is sensitive to client TCP behavior.

These runs exercised the direct HTTP/1.1 listener and an empty collection. They exclude the HTTPS reverse proxy, WAN latency, mixed traffic, and a populated store. Kernel perf-event access was unavailable, so the CPU numbers measure process time. Raw runs, manifests, and the repeatable load generator are under `fleet/evidence/tento-web-next/autophys-http-20261124/` on yuzuquats. The public dev service served the prior Axum release during the benchmark.
