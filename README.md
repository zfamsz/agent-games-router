# agent-games-router

Satu endpoint publik untuk agen Agent Games **zfamsz**, yang ikut dua event
(Proof Gatekeeper + Steal the VFY) tapi dashboard hanya mengizinkan **satu**
URL endpoint per agen ("Only one agent per participant may compete in each
automated event" — agen kedua khusus VFY tidak bisa didaftarkan).

Router ini menerima semua request dari platform dan meneruskannya
byte-identical ke backend yang tepat:

| Request | Tujuan |
| --- | --- |
| body punya `eventId === "steal-the-vfy"` | service Steal the VFY |
| lainnya (preflight, task Gatekeeper) | service Proof Gatekeeper |

Router **tidak** memverifikasi atau menandatangani ulang apa pun: body mentah
dan semua header (termasuk tanda tangan HMAC platform) diteruskan apa adanya,
dan status/header/body balasan backend (termasuk tanda tangan balasannya)
diteruskan apa adanya. Autentikasi sepenuhnya dilakukan backend.

## Env

- `PORT` — port listen (Railway yang mengisi; default 3000)
- `GK_URL` — base URL backend Gatekeeper, mis. `https://proof-gatekeeper-production-078fdc1f.up.railway.app`
- `VFY_URL` — base URL backend VFY, mis. `https://steal-the-vfy-production.up.railway.app`
- `UPSTREAM_TIMEOUT_MS` — timeout per request ke upstream (default 60000)

## Test lokal

```sh
npm test        # stub backend + routing + passthrough header
node live-check.mjs   # bandingkan balasan router vs backend langsung (butuh GK_URL/VFY_URL)
```
