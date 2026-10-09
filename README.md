<p align="center">
  <img src="banner.png" alt="Code Ledger" width="100%">
</p>

<h1 align="center">Code Ledger · $CLEDGER</h1>

<p align="center">
  <b>Two paths. One pick by the code. One vote by the holders. 32 trades to prove it.</b>
</p>

<p align="center">
  <a href="https://x.com/codeledgr">X: @codeledgr</a>
</p>

---

## 📈 Live stats

<sub>Updated automatically from the blockchain every few minutes.</sub>

<!-- STATS:START -->
**Price now:** 1 CLEDGER ≈ 0.00000001024 ETH

### 📒 Round #2 — 🗳️ Voting is open

| | |
|---|---|
| 🐱 Code picked | ⬇️ DOWN |
| ⬆️ UP target | 0.00000002067 ETH (+16.18%) |
| ⬇️ DOWN target | 0.00000001531 ETH (-13.93%) |
| 🗳️ Community vote | no votes yet |
| ⏰ Voting closes | 20:05 UTC |

### 🏆 Scoreboard

| Rounds finished | 🎯 Hits | ❌ Misses | Hit rate |
|:---:|:---:|:---:|:---:|
| 1 | 1 | 0 | 100% |

### 💸 Fees shared in ETH

| 👥 To holders | 🛠️ To development | ✅ Already claimed |
|:---:|:---:|:---:|
| 0.8194 ETH | 0.2476 ETH | 0.0275 ETH |

### 📜 Latest rounds

| Round | 🐱 Code | 🗳️ Community | 🛤️ Played | Result |
|:---:|:---:|:---:|:---:|:---:|
| #2 | ⬇️ DOWN | tie / no votes | — | … |
| #1 | ⬆️ UP | tie / no votes | ⬆️ UP | 🎯 HIT on trade 1 |
<!-- STATS:END -->

---

## 🐱 What is this?

Code Ledger ($CLEDGER) is a token on Ethereum. Every trade pays a small fee in ETH: **1% on buys,
4% on sells**. That ETH goes back to the community:

- **75%** to everyone holding CLEDGER
- **25%** to development

Holders can claim their ETH whenever they like.

## 🛤️ TWO PATHS

Every round is a small prediction game.

1. **The code makes a forecast.** It looks at the last 32 trades and sets two price targets, one
   **UP** and one **DOWN**. It also picks the path it believes in.
2. **Holders vote for 10 minutes.** UP or DOWN, one vote per wallet, weighted by how much
   CLEDGER the wallet holds. If the vote is tied or nobody votes, the code's pick is used.
3. **The next 32 trades decide.** If the price reaches the chosen target within those 32 trades,
   it's a **🎯 HIT**. If not, it's a **❌ MISS**.
4. **A HIT pays holders more.** From the trade after the HIT until trade 32, **100%** of fees go
   to holders.
5. Then the next round begins.

## 🤖 How the code picks

The forecast is made by this repository. The same public recipe runs every time, and it uses
only data from the blockchain:

- **Where the price went** over the last 32 trades
- **Who was stronger**, buyers or sellers, measured in ETH
- **What happened most recently**, over the last 8 trades
- **How much the price moves**, which sets how far away the targets are

There is no secret input and no human decision. Anyone can re-run the recipe and get the same
answer. Voting, counting trades, HIT or MISS, and fee sharing all happen on the blockchain. This
bot only proposes the forecast.

## 🔍 For developers

Setup, the exact formula and the safety checks are in
[docs/TECHNICAL.md](docs/TECHNICAL.md).

<p align="center"><sub>Code Ledger · native ETH rewards · Uniswap v4 · Ethereum Mainnet</sub></p>
