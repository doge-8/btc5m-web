# BTC 5m User Edition

## Included Files

- `server.ts`
- `index.html`
- `package.json`
- `package-lock.json`
- `.env.example`
- `start.sh`
- `start.bat`
- `STRATEGIES-GUIDE.md`

## How to Use

1. Install Node.js 20 or higher.
2. Copy `.env.example` to `.env`.
3. Fill in:
   - `POLYMARKET_PRIVATE_KEY` — Polygon wallet private key
   - `POLYMARKET_PROXY_ADDRESS` — **NOT the deposit address!** Log in to polymarket.com → top-right avatar → Settings → Wallet → copy "Proxy Wallet" (maps one-to-one with the private key; a wrong value triggers invalid signature)
4. Adjust as needed:
   - `APP_MODE=full`: with the web panel
   - `APP_MODE=headless`: backend only
   - `STRATEGY_S1_ENABLED/STRATEGY_S2_ENABLED/STRATEGY_S3_ENABLED`
   - `STRATEGY_S1_AMOUNT/STRATEGY_S2_AMOUNT/STRATEGY_S3_AMOUNT`
5. Start:
   - macOS / Linux: `./start.sh`
   - Windows: double-click `start.bat`

## Notes

- On every startup, the default strategy config is initialized from `.env`.
- Changing strategy switches and amounts in the web UI only applies to the current run; after restart it follows `.env` again.
- In `full` mode you can view status, place orders manually, and temporarily toggle strategies via the web UI.
- In `headless` mode you can view status via `/api/state`.
- `STRATEGIES-GUIDE.md` summarizes the triggers, take-profit/stop-loss, buy confirmation, and state-machine semantics of the current 3 strategies.

## Security

- Do not give your real `.env` and `.polymarket-creds.json` to anyone.
- If deploying to a cloud server, we recommend accessing the web panel via an SSH tunnel and not exposing the port directly to the public internet.

## Accessing the Panel via SSH Tunnel

If the service runs on a cloud server, we recommend using an SSH tunnel to access the panel from your local browser.

### 1. Server-Side Requirements

- Set `APP_MODE=full` in `.env`
- The service is already running normally

### 2. Password Login

Run on your own computer:

```bash
ssh -L 3456:127.0.0.1:3456 username@server_IP
```

For example:

```bash
ssh -L 3456:127.0.0.1:3456 root@1.2.3.4
```

Then open in your local browser:

```text
http://127.0.0.1:3456
```

### 3. Key-Based Login

If the server uses private-key login:

```bash
ssh -i ~/.ssh/your_private_key_file -L 3456:127.0.0.1:3456 username@server_IP
```

For example:

```bash
ssh -i ~/.ssh/my-server.pem -L 3456:127.0.0.1:3456 ubuntu@1.2.3.4
```

Then open in your local browser:

```text
http://127.0.0.1:3456
```

### 4. If the SSH Port Is Not 22

For example, if the SSH port is `2222`:

```bash
ssh -i ~/.ssh/my-server.pem -p 2222 -L 3456:127.0.0.1:3456 ubuntu@1.2.3.4
```

### 5. If Local Port 3456 Is Already in Use

You can change the local port to `8888`:

```bash
ssh -L 8888:127.0.0.1:3456 username@server_IP
```

Or:

```bash
ssh -i ~/.ssh/my-server.pem -L 8888:127.0.0.1:3456 ubuntu@1.2.3.4
```

Then open in the browser:

```text
http://127.0.0.1:8888
```

### 6. Notes

- As long as you can SSH into the server, you can access the panel this way.
- Closing the SSH tunnel only affects local viewing; it does not affect the program continuing to run on the server.
- If you only want to check the API status, you can also access it locally:

```bash
curl http://127.0.0.1:3456/api/state
```
