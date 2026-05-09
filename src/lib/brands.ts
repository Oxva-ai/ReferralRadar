// UK brands with known or likely referral programs, organized by category.
// Used for targeted search queries and company name resolution.
// Based on referralcodes.com categories + UK-specific additions.

export interface UkBrand {
  name: string
  domain: string
  category: string
  likelyReferralPage?: string  // Known referral page path, if any
}

export const UK_BRANDS: UkBrand[] = [
  // === BANKING & FINTECH ===
  { name: 'Monzo', domain: 'monzo.com', category: 'banking' },
  { name: 'Starling Bank', domain: 'starlingbank.com', category: 'banking' },
  { name: 'Revolut', domain: 'revolut.com', category: 'banking' },
  { name: 'Wise', domain: 'wise.com', category: 'banking' },
  { name: 'Chase UK', domain: 'chase.co.uk', category: 'banking' },
  { name: 'Kroo', domain: 'kroo.com', category: 'banking' },
  { name: 'Zopa', domain: 'zopa.com', category: 'banking' },
  { name: 'Monese', domain: 'monese.com', category: 'banking' },
  { name: 'First Direct', domain: 'firstdirect.com', category: 'banking', likelyReferralPage: '/refer-a-friend' },
  { name: 'Nationwide', domain: 'nationwide.co.uk', category: 'banking' },
  { name: 'Santander UK', domain: 'santander.co.uk', category: 'banking' },
  { name: 'HSBC UK', domain: 'hsbc.co.uk', category: 'banking' },
  { name: 'Barclays', domain: 'barclays.co.uk', category: 'banking' },
  { name: 'Lloyds Bank', domain: 'lloydsbank.com', category: 'banking' },
  { name: 'NatWest', domain: 'natwest.com', category: 'banking' },
  { name: 'Virgin Money', domain: 'virginmoney.com', category: 'banking' },
  { name: 'Tandem Bank', domain: 'tandem.co.uk', category: 'banking' },
  { name: 'Monument Bank', domain: 'monument.co', category: 'banking' },
  { name: 'Atom Bank', domain: 'atombank.co.uk', category: 'banking' },
  { name: 'Allica Bank', domain: 'allica.bank', category: 'banking' },

  // === INVESTING & TRADING ===
  { name: 'Trading 212', domain: 'trading212.com', category: 'investing' },
  { name: 'Freetrade', domain: 'freetrade.io', category: 'investing' },
  { name: 'eToro', domain: 'etoro.com', category: 'investing' },
  { name: 'Nutmeg', domain: 'nutmeg.com', category: 'investing' },
  { name: 'Moneybox', domain: 'moneyboxapp.com', category: 'investing' },
  { name: 'PensionBee', domain: 'pensionbee.com', category: 'investing' },
  { name: 'Coinbase', domain: 'coinbase.com', category: 'crypto' },
  { name: 'Binance', domain: 'binance.com', category: 'crypto' },
  { name: 'Kraken', domain: 'kraken.com', category: 'crypto' },
  { name: 'Luno', domain: 'luno.com', category: 'crypto' },
  { name: 'Nexo', domain: 'nexo.com', category: 'crypto' },
  { name: 'Crypto.com', domain: 'crypto.com', category: 'crypto' },
  { name: 'Gemini', domain: 'gemini.com', category: 'crypto' },
  { name: 'Uphold', domain: 'uphold.com', category: 'crypto' },
  { name: 'Plum', domain: 'withplum.com', category: 'investing' },
  { name: 'Dodl', domain: 'dodl.co.uk', category: 'investing' },
  { name: 'InvestEngine', domain: 'investengine.com', category: 'investing' },
  { name: 'Hargreaves Lansdown', domain: 'hl.co.uk', category: 'investing' },
  { name: 'AJ Bell', domain: 'ajbell.co.uk', category: 'investing' },
  { name: 'Vanguard UK', domain: 'vanguardinvestor.co.uk', category: 'investing' },
  { name: 'Fidelity UK', domain: 'fidelity.co.uk', category: 'investing' },
  { name: 'Wealthify', domain: 'wealthify.com', category: 'investing' },
  { name: 'Wombat Invest', domain: 'wombatinvest.com', category: 'investing' },
  { name: 'Lightyear', domain: 'lightyear.com', category: 'investing' },
  { name: 'Shares.io', domain: 'shares.io', category: 'investing' },
  { name: 'Robinhood UK', domain: 'robinhood.com', category: 'investing' },

  // === MONEY TRANSFER & FX ===
  { name: 'Currensea', domain: 'currensea.com', category: 'finance' },
  { name: 'Atlantic Money', domain: 'atlantic.money', category: 'finance' },
  { name: 'Xe.com', domain: 'xe.com', category: 'finance' },
  { name: 'Remitly', domain: 'remitly.com', category: 'finance' },
  { name: 'WorldRemit', domain: 'worldremit.com', category: 'finance' },
  { name: 'Taptap Send', domain: 'taptapsend.com', category: 'finance' },

  // === FOOD & DRINK ===
  { name: 'HelloFresh', domain: 'hellofresh.co.uk', category: 'food' },
  { name: 'Gousto', domain: 'gousto.co.uk', category: 'food' },
  { name: 'Mindful Chef', domain: 'mindfulchef.com', category: 'food' },
  { name: 'Green Chef', domain: 'greenchef.co.uk', category: 'food' },
  { name: 'SimplyCook', domain: 'simplycook.com', category: 'food' },
  { name: 'Allplants', domain: 'allplants.com', category: 'food' },
  { name: 'Pasta Evangelists', domain: 'pastaevangelists.com', category: 'food' },

  // === DELIVERY ===
  { name: 'Deliveroo', domain: 'deliveroo.co.uk', category: 'food' },
  { name: 'Uber Eats', domain: 'ubereats.com', category: 'food' },
  { name: 'Just Eat', domain: 'just-eat.co.uk', category: 'food' },
  { name: 'Getir', domain: 'getir.com', category: 'food' },
  { name: 'Gorillas', domain: 'gorillas.io', category: 'food' },
  { name: 'Zapp', domain: 'tryzapp.com', category: 'food' },

  // === SHOPPING & CASHBACK ===
  { name: 'Quidco', domain: 'quidco.com', category: 'shopping' },
  { name: 'TopCashback', domain: 'topcashback.co.uk', category: 'shopping' },
  { name: 'Shopmium', domain: 'shopmium.com', category: 'shopping' },
  { name: 'GreenJinn', domain: 'greenjinn.com', category: 'shopping' },
  { name: 'CheckoutSmart', domain: 'checkoutsmart.com', category: 'shopping' },
  { name: 'JamDoughnut', domain: 'jamdoughnut.com', category: 'shopping' },
  { name: 'Airtime Rewards', domain: 'airtimerewards.com', category: 'shopping' },
  { name: 'Cheddar', domain: 'cheddar.me', category: 'shopping' },
  { name: 'Daali', domain: 'daali.co.uk', category: 'shopping' },
  { name: 'Sprive', domain: 'sprive.com', category: 'shopping' },
  { name: 'Curve', domain: 'curve.com', category: 'finance' },
  { name: 'Vinted', domain: 'vinted.co.uk', category: 'shopping' },
  { name: 'Depop', domain: 'depop.com', category: 'shopping' },
  { name: 'eBay UK', domain: 'ebay.co.uk', category: 'shopping' },

  // === ENERGY ===
  { name: 'Octopus Energy', domain: 'octopus.energy', category: 'utilities' },
  { name: 'Ovo Energy', domain: 'ovoenergy.com', category: 'utilities' },
  { name: 'Bulb', domain: 'bulb.co.uk', category: 'utilities' },
  { name: 'E.ON Next', domain: 'eonnext.com', category: 'utilities' },
  { name: 'British Gas', domain: 'britishgas.co.uk', category: 'utilities' },
  { name: 'EDF Energy', domain: 'edfenergy.com', category: 'utilities' },
  { name: 'Scottish Power', domain: 'scottishpower.co.uk', category: 'utilities' },
  { name: 'Shell Energy', domain: 'shellenergy.co.uk', category: 'utilities' },
  { name: 'So Energy', domain: 'so.energy', category: 'utilities' },
  { name: 'Utility Warehouse', domain: 'utilitywarehouse.co.uk', category: 'utilities' },

  // === BROADBAND & MOBILE ===
  { name: 'Virgin Media', domain: 'virginmedia.com', category: 'utilities' },
  { name: 'Sky', domain: 'sky.com', category: 'utilities' },
  { name: 'BT', domain: 'bt.com', category: 'utilities' },
  { name: 'EE', domain: 'ee.co.uk', category: 'utilities' },
  { name: 'Three', domain: 'three.co.uk', category: 'utilities' },
  { name: 'Vodafone', domain: 'vodafone.co.uk', category: 'utilities' },
  { name: 'O2', domain: 'o2.co.uk', category: 'utilities' },
  { name: 'Giffgaff', domain: 'giffgaff.com', category: 'utilities' },
  { name: 'Voxi', domain: 'voxi.co.uk', category: 'utilities' },
  { name: 'Smarty', domain: 'smarty.co.uk', category: 'utilities' },
  { name: 'Lebara', domain: 'lebara.co.uk', category: 'utilities' },
  { name: 'Lyca Mobile', domain: 'lycamobile.co.uk', category: 'utilities' },
  { name: 'TalkTalk', domain: 'talktalk.co.uk', category: 'utilities' },
  { name: 'Plusnet', domain: 'plus.net', category: 'utilities' },
  { name: 'Hyperoptic', domain: 'hyperoptic.com', category: 'utilities' },
  { name: 'Community Fibre', domain: 'communityfibre.co.uk', category: 'utilities' },
  { name: 'Zen Internet', domain: 'zen.co.uk', category: 'utilities' },

  // === INSURANCE ===
  { name: 'Marmalade', domain: 'wearemarmalade.co.uk', category: 'insurance' },
  { name: 'By Miles', domain: 'bymiles.co.uk', category: 'insurance' },
  { name: 'Cuvva', domain: 'cuvva.com', category: 'insurance' },
  { name: 'Marshmallow', domain: 'marshmallow.com', category: 'insurance' },
  { name: 'Zego', domain: 'zego.com', category: 'insurance' },
  { name: 'Admiral', domain: 'admiral.com', category: 'insurance' },
  { name: 'Direct Line', domain: 'directline.com', category: 'insurance' },
  { name: 'Aviva', domain: 'aviva.co.uk', category: 'insurance' },
  { name: 'LV=', domain: 'lv.com', category: 'insurance' },
  { name: 'Vitality', domain: 'vitality.co.uk', category: 'insurance' },

  // === FITNESS & HEALTH ===
  { name: 'PureGym', domain: 'puregym.com', category: 'health' },
  { name: 'The Gym Group', domain: 'thegymgroup.com', category: 'health' },
  { name: 'ClassPass', domain: 'classpass.com', category: 'health' },
  { name: 'Huel', domain: 'huel.com', category: 'health' },
  { name: 'Grenade', domain: 'grenade.com', category: 'health' },
  { name: 'Myprotein', domain: 'myprotein.com', category: 'health' },
  { name: 'Bulk', domain: 'bulk.com', category: 'health' },
  { name: 'Free Soul', domain: 'freesoul.com', category: 'health' },
  { name: 'Weight Loss Plans', domain: 'weightlossplans.co.uk', category: 'health' },
  { name: 'Second Nature', domain: 'secondnature.io', category: 'health' },
  { name: 'Noom', domain: 'noom.com', category: 'health' },
  { name: 'WeightWatchers UK', domain: 'weightwatchers.com', category: 'health' },

  // === TRAVEL ===
  { name: 'Trainline', domain: 'trainline.com', category: 'travel' },
  { name: 'Booking.com', domain: 'booking.com', category: 'travel' },
  { name: 'Airbnb', domain: 'airbnb.co.uk', category: 'travel' },
  { name: 'Skyscanner', domain: 'skyscanner.net', category: 'travel' },
  { name: 'Trivago', domain: 'trivago.co.uk', category: 'travel' },
  { name: 'Expedia', domain: 'expedia.co.uk', category: 'travel' },
  { name: 'Hotels.com', domain: 'hotels.com', category: 'travel' },

  // === PETS ===
  { name: 'Republic of Cats', domain: 'republicofcats.com', category: 'pets' },
  { name: 'Tails.com', domain: 'tails.com', category: 'pets' },
  { name: 'Butternut Box', domain: 'butternutbox.com', category: 'pets' },
  { name: 'Different Dog', domain: 'differentdog.com', category: 'pets' },
  { name: 'KatKin', domain: 'katkin.com', category: 'pets' },
  { name: 'Scrumbles', domain: 'scrumbles.co.uk', category: 'pets' },
  { name: 'Pets at Home', domain: 'petsathome.com', category: 'pets' },

  // === SUBSCRIPTIONS & SERVICES ===
  { name: 'Nordic Spirit', domain: 'nordicspirit.co.uk', category: 'other' },
  { name: 'Beer52', domain: 'beer52.com', category: 'food' },
  { name: 'Wine52', domain: 'wine52.com', category: 'food' },
  { name: 'Laithwaites', domain: 'laithwaites.co.uk', category: 'food' },
  { name: 'Naked Wines', domain: 'nakedwines.com', category: 'food' },
  { name: 'Smol', domain: 'smolproducts.com', category: 'other' },
  { name: 'Who Gives A Crap', domain: 'whogivesacrap.org', category: 'other' },
  { name: 'Wild Deodorant', domain: 'wearewild.com', category: 'other' },
  { name: 'Fussy', domain: 'getfussy.com', category: 'other' },
  { name: 'Grind Coffee', domain: 'grind.co.uk', category: 'food' },
  { name: 'Pact Coffee', domain: 'pactcoffee.com', category: 'food' },
  { name: 'Odd Coffee', domain: 'oddcoffeeco.com', category: 'food' },
  { name: 'Freddie Flowers', domain: 'freddiesflowers.com', category: 'other' },
  { name: 'Bloom & Wild', domain: 'bloomandwild.com', category: 'other' },
  { name: 'Arena Flowers', domain: 'arenaflowers.com', category: 'other' },
  { name: 'Moonpig', domain: 'moonpig.com', category: 'other' },
  { name: 'Funky Pigeon', domain: 'funkypigeon.com', category: 'other' },
  { name: 'Not On The High Street', domain: 'notonthehighstreet.com', category: 'shopping' },
  { name: 'Etsy UK', domain: 'etsy.com', category: 'shopping' },
  { name: 'Farfetch', domain: 'farfetch.com', category: 'shopping' },
  { name: 'ASOS', domain: 'asos.com', category: 'shopping' },
  { name: 'Boohoo', domain: 'boohoo.com', category: 'shopping' },
  { name: 'PrettyLittleThing', domain: 'prettylittlething.com', category: 'shopping' },
  { name: 'Missguided', domain: 'missguided.co.uk', category: 'shopping' },
  { name: 'Gymshark', domain: 'gymshark.com', category: 'shopping' },
  { name: 'Beauty Pie', domain: 'beautypie.com', category: 'shopping' },
  { name: 'Lookfantastic', domain: 'lookfantastic.com', category: 'shopping' },
  { name: 'Cult Beauty', domain: 'cultbeauty.co.uk', category: 'shopping' },
  { name: 'Feelunique', domain: 'feelunique.com', category: 'shopping' },

  // === GAMBLING (flagged, not auto-served) ===
  { name: 'Bet365', domain: 'bet365.com', category: 'gambling' },
  { name: 'Paddy Power', domain: 'paddypower.com', category: 'gambling' },
  { name: 'Betfair', domain: 'betfair.com', category: 'gambling' },
  { name: 'William Hill', domain: 'williamhill.com', category: 'gambling' },
  { name: 'Ladbrokes', domain: 'ladbrokes.com', category: 'gambling' },
  { name: 'Coral', domain: 'coral.co.uk', category: 'gambling' },
  { name: 'Sky Bet', domain: 'skybet.com', category: 'gambling' },
  { name: '888sport', domain: '888sport.com', category: 'gambling' },
  { name: 'Betway', domain: 'betway.com', category: 'gambling' },
  { name: 'Unibet', domain: 'unibet.co.uk', category: 'gambling' },

  // === PARKING & GAMES ===
  { name: 'Pick My Postcode', domain: 'pickmypostcode.com', category: 'other' },
  { name: 'Park Christmas Savings', domain: 'parkchristmassavings.com', category: 'finance' },
  { name: 'Kidstart', domain: 'kidstart.co.uk', category: 'finance' },
  { name: 'GoHenry', domain: 'gohenry.com', category: 'finance' },
  { name: 'Nimbl', domain: 'nimbl.com', category: 'finance' },
  { name: 'HyperJar', domain: 'hyperjar.com', category: 'finance' },
  { name: 'Monese', domain: 'monese.com', category: 'banking' },
  { name: 'Snoop', domain: 'snoop.app', category: 'finance' },
  { name: 'Moneyhub', domain: 'moneyhub.com', category: 'finance' },
  { name: 'Emma', domain: 'emma-app.com', category: 'finance' },
  { name: 'Chip', domain: 'chip.uk', category: 'finance' },
  { name: 'Cleo', domain: 'cleo.com', category: 'finance' },
  { name: 'Loot', domain: 'loot.io', category: 'finance' },
]

// Build lookup maps
export const BRAND_BY_DOMAIN: Record<string, UkBrand> = {}
for (const brand of UK_BRANDS) {
  BRAND_BY_DOMAIN[brand.domain] = brand
  BRAND_BY_DOMAIN[`www.${brand.domain}`] = brand
}

// Get company name from domain
export function getCompanyName(domain: string): string | null {
  return BRAND_BY_DOMAIN[domain.toLowerCase()]?.name ?? null
}

// Get category from domain
export function getCategory(domain: string): string | null {
  return BRAND_BY_DOMAIN[domain.toLowerCase()]?.category ?? null
}

// Generate targeted search queries for all brands
export function getBrandSearchQueries(): Array<{ brand: UkBrand; query: string }> {
  return UK_BRANDS.map(brand => ({
    brand,
    query: `"${brand.name}" referral OR "refer a friend" OR "invite friends"`,
  }))
}
