# TAO — the native asset

TAO is the native token of Bittensor. It's the unit miners and validators are rewarded in, the unit subnet registration is paid in, and the unit traders buy and sell on exchanges. TAO is used inside the network for staking (validators must have stake — their own or delegated — to influence consensus), and outside the network as a regular crypto asset that trades on major exchanges.

The total supply is capped at 21 million TAO — a deliberate echo of Bitcoin's cap. There is no premine in the public sense and no team allocation that vests over time as a separate stream; emissions are paid out by the protocol per-block to active subnets, miners, validators, and subnet owners.

# Halvings — a four-year emission cadence

Bittensor halvings cut the per-block emission rate roughly in half every four years, also mirroring Bitcoin's design. Each halving slows the rate at which new TAO enters circulation, creating a deflationary curve that approaches but never reaches the 21 million cap. The first halving has already occurred; subsequent halvings continue on the four-year cadence until effectively all TAO is in circulation.

# Rao — the smallest unit

The smallest indivisible unit of TAO is called a "rao". One TAO equals one billion rao (10^9). On-chain balances and transfers are denominated in rao internally — the wallet UI shows TAO with up to nine decimal places of precision. Calling balances "rao" is a tribute to one of the project's co-founders, who goes by the pseudonym Rao.

# Staking and delegation

Holders of TAO can stake it onto a validator hotkey to earn a share of that validator's emissions. You can stake to your own validator if you run one, or delegate to someone else's validator and earn a portion of the rewards as a passive holder. Validators usually publish a "delegate take" — the percentage of rewards they keep before splitting the rest pro-rata among delegators. Staking is non-custodial: the TAO sits at your coldkey, just bonded to a validator hotkey for consensus weight. You can unstake at any time, subject to short waiting periods.

# dTAO — dynamic emissions per subnet

Before dTAO, subnet emissions were governed by a single "root subnet" of validators that set weights deciding how much each subnet earned. This concentrated influence in the largest stakers and made subnets compete politically rather than economically. dTAO ("dynamic TAO") replaced that with a per-subnet alpha token and an automated market maker pool.

Each subnet has its own alpha token. Anyone can buy that subnet's alpha by paying TAO into the subnet's pool, or sell alpha back to TAO. The relative price of alpha to TAO determines the subnet's share of network emissions: subnets with higher alpha price (more demand) earn a larger slice of new TAO emissions, subnets with lower alpha price earn less. This turns subnet competition into a market — buyers vote on which subnets matter by paying TAO into them, and the protocol responds by directing more emissions to those subnets.

Inside a subnet, miners and validators are paid in that subnet's alpha (which they can swap to TAO via the pool whenever they want). Subnet owners earn a share of alpha emissions as well. Vocence has its own alpha token tied to Subnet 78.

# Subnet registration cost

Registering a new subnet requires paying a registration fee, denominated in TAO and adjusted by network demand. The fee is a recoupable cost — owners earn it back through their share of subnet emissions if the subnet attracts demand. There's also a periodic "subnet survival" cost: subnets that don't attract miners, validators, and demand can be deregistered, freeing the slot for a new project. Slots are limited (a fixed number of active subnets at any time), so registration competes for scarce slots when the network is full.

Miner registration within a subnet also costs alpha (post-dTAO). The cost adjusts dynamically based on how full the miner slots are — when registration demand is high, the cost rises; when miners are exiting, it drops. This prevents a single actor from cheaply spamming the subnet with throwaway hotkeys.

# Where TAO trades

TAO trades on major centralized and decentralized exchanges. The supply is liquid enough that price discovery is reliable, though TAO's price (like all crypto) is volatile. Vocence does not give price advice — for live prices, check coingecko.com or coinmarketcap.com. Vocence accepts BTC, ETH, USDT, and USDC for credit purchases via NOWPayments; we do not currently accept TAO directly as a payment method on the product side.

# What this matters for Vocence

For Studio users, the TAO economy is invisible — you pay USD (card or stablecoin) for credits, and Vocence handles the TAO-side of paying miners on Subnet 78. For miners and validators on the subnet, alpha and TAO are how you get paid, and the dTAO market dynamics affect how much your subnet earns over time relative to other subnets on Bittensor. The healthier the demand for Vocence's voice generation, the higher the alpha price tends to drift, and the larger the share of network emissions Subnet 78 captures.
