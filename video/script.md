# Demo video v1 — narration script

Stock Agent on Base · Base Stocks Maxxing (Agentic Stock Finance track)
English narration (ElevenLabs TTS), captions burned in from this text.
Runtime 2:07. Reconstructed from the produced captions track
(`work/captions.srt`) after the production session stalled post-render.

---

Coinbase's tokenized stocks trade on Base around the clock.

But their reference price — a Chainlink NAV — only updates during market
hours, twenty-four hours a day, five days a week.

So live prices drift away from the reference, dislocations appear and
vanish, and with eighty-nine tokens listed, nobody can watch all of them
by hand.

This is Stock Agent on Base.

It tracks all eighty-nine tokenized stocks, and every twenty minutes it
snapshots the market: the live Aerodrome pool price on Base mainnet, set
against the Chainlink NAV.

For each of the twelve tokens that publish a NAV, you see the premium or
discount, the pool depth, and whether the feed is fresh — or stale.

Only pools deeper than ten thousand dollars count toward a signal.

Dust pools are flagged, and ignored.

Then the agent decides.

It verifies every Chainlink feed onchain — they match the API to the last
digit — scores all twelve tokens, and rebalances under hard rules: never
buy above a three percent premium, never hold more than twenty-five
percent in a single name, and if a feed goes stale, that token freezes.

Its first decision bought the top five by score — Apple, Microsoft,
SpaceX, Meta, and Amazon — twenty thousand dollars each, at the live NAV.

The cycle you just saw held: every position was still inside its band.

And nothing is hidden.

Every decision is stored as a full record: the scores behind it, the
prices, the rules that fired, and a plain-English rationale.

The executed buys.

The deliberate no-ops.

Even the rejection, when a trade broke a rule.

A hold is a decision too — recorded with the same care as a trade.

To be clear: this is a paper portfolio.

No real funds are held, moved, or at risk.

It is research infrastructure — not financial advice.

The code is open source, built in the open for the Base Stocks Maxxing
quest.

Stock Agent on Base: an agent that watches the whole market, so you
don't have to.
