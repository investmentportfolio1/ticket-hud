# Ticker HUD

Live stock prices from Finnhub on Even Realities G2 glasses.

- **Phone:** a settings screen (API key, watchlist, refresh speed) plus a live preview.
- **Glasses:** your watchlist, 8 per page: symbol, price, and day change (▲/▼ %), with US market open/closed and the last update time.
- **Controls on the glasses:** swipe to change page, tap to refresh now, double-tap to exit.

Your API key is saved only on your phone (in the Even app's storage). It is never written into the code.

## What you need

- A computer (Mac or Windows) with **Node.js** installed: download the "LTS" version from https://nodejs.org
- Your phone with the Even app, paired with your G2
- Computer and phone on the **same Wi-Fi**

## Run it (first time)

1. Unzip this folder somewhere easy, like your Desktop.
2. Open a terminal in the folder:
   - **Mac:** open Terminal, type `cd ` (with a space), drag the `ticker-hud` folder into the window, press Enter.
   - **Windows:** open the folder, click the address bar, type `cmd`, press Enter.
3. Install the parts it needs (one time only):
   ```
   npm install
   ```
4. Start the app:
   ```
   npm run dev
   ```
   Leave this window open. It prints a "Network" address like `http://192.168.1.23:5173`.
5. Open a **second** terminal in the same folder and make the QR code, using that Network address:
   ```
   npx evenhub qr --url http://192.168.1.23:5173
   ```
6. In the Even app on your phone, scan the QR code. Ticker HUD opens on your phone.
7. Paste your Finnhub API key, type your tickers (e.g. `AAPL, NVDA, TSLA`), tap **Save and start**.
   The watchlist appears on the glasses.

## Optional: test on the computer first

- Open `http://localhost:5173` in a browser: the settings and live preview work there (no glasses needed).
- `npm run simulate` opens Even's G2 simulator to see the glasses screen on your desktop.

## Notes

- **Finnhub free plan:** 60 requests per minute. The app automatically slows refreshes for long watchlists (e.g. 30 tickers refresh about every 36 seconds) and backs off if Finnhub says "rate limit".
- **Symbols:** US stocks work on the free plan. Unknown symbols show "not found".
- This setup runs from your computer, so the computer must stay on and on the same Wi-Fi. The next step is hosting it online so it works anywhere.

## Files

- `src/main.ts`: settings, refresh loop, glasses controls
- `src/glasses.ts`: what's drawn on the G2 display
- `src/finnhub.ts`: Finnhub requests and rate-limit handling
- `index.html`: the phone settings screen
- `app.json`: Even Hub app manifest (allows network access to finnhub.io only)
