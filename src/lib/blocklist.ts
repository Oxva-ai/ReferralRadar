// Domains to skip — aggregators, forums, personal pages, known spam
export const SKIP_DOMAINS = [
  // Aggregator/referral code sites
  'getareferral.com', 'thereferralguy.com', 'referralcodes.com',
  'referralcode.org', 'referralcodes.co.uk', 'referralfinder.com',
  'referralhero.com', 'referralhub.com', 'refer-me.com',
  'referral.link', 'referral.world', 'invite.codes',
  // Forums / Q&A
  'reddit.com', 'quora.com', 'stackexchange.com',
  'stackoverflow.com', 'medium.com',
  // Competitor aggregators
  'hotukdeals.com', 'moneysavingexpert.com', 'latestdeals.co.uk',
  'magicfreebiesuk.co.uk', 'myvouchercodes.co.uk', 'vouchercodes.co.uk',
  // Personal/social
  'linktr.ee', 'bio.link', 'beacons.ai', 'carrd.co',
  'tiktok.com', 'instagram.com', 'facebook.com', 'twitter.com',
  'x.com', 'youtube.com', 'linkedin.com',
  // File hosting / docs
  'docs.google.com', 'drive.google.com', 'imgbb.com', 'imgur.com',
  'dropbox.com', 'pastebin.com', 'github.com',
  // Survey/offer walls
  'fivesurveys.com', 'swagbucks.com', 'freecash.com',
  'inboxpounds.co.uk', 'test.io', 'testingtime.com',
  // Generic non-referral
  'google.com', 'bing.com', 'yahoo.com',
  // Known spam domains (add as discovered)
]

export function isSkipDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return SKIP_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))
  } catch {
    return true
  }
}

// Known UK companies for company name lookup
export const KNOWN_UK_COMPANIES: Record<string, string> = {
  'monzo.com': 'Monzo',
  'starlingbank.com': 'Starling Bank',
  'revolut.com': 'Revolut',
  'wise.com': 'Wise',
  'chase.co.uk': 'Chase UK',
  'paypal.com': 'PayPal',
  'curve.com': 'Curve',
  'trading212.com': 'Trading 212',
  'freetrade.io': 'Freetrade',
  'hellofresh.co.uk': 'HelloFresh',
  'gousto.co.uk': 'Gousto',
  'deliveroo.co.uk': 'Deliveroo',
  'octopus.energy': 'Octopus Energy',
  'puregym.com': 'PureGym',
  'trainline.com': 'Trainline',
  'coinbase.com': 'Coinbase',
  'kraken.com': 'Kraken',
  'quidco.com': 'Quidco',
  'topcashback.co.uk': 'TopCashback',
  'moneyboxapp.com': 'Moneybox',
  'pensionbee.com': 'PensionBee',
  'nutmeg.com': 'Nutmeg',
  'etoro.com': 'eToro',
  'binance.com': 'Binance',
  'voxi.co.uk': 'Voxi',
  'currensea.com': 'Currensea',
  'virginmedia.com': 'Virgin Media',
  'sky.com': 'Sky',
  'bt.com': 'BT',
  'ee.co.uk': 'EE',
  'three.co.uk': 'Three',
  'vodafone.co.uk': 'Vodafone',
  'o2.co.uk': 'O2',
  'nordicspirit.co.uk': 'Nordic Spirit',
  'sprive.com': 'Sprive',
  'fidelity.co.uk': 'Fidelity',
  'rakuten.co.uk': 'Rakuten UK',
  'classpass.com': 'ClassPass',
  'shopmium.com': 'Shopmium',
  'airtime.co.uk': 'Airtime',
  'airtimerewards.com': 'Airtime Rewards',
  'parkchristmassavings.com': 'Park Christmas Savings',
  'pickmypostcode.com': 'Pick My Postcode',
  'republicofcats.com': 'Republic of Cats',
  'taptapsend.com': 'Taptap Send',
  'monument.co': 'Monument Bank',
  'weightlossplans.co.uk': 'Weight Loss Plans',
  'vinted.co.uk': 'Vinted',
  'nexo.com': 'Nexo',
  'brighty.app': 'Brighty',
  'tonies.com': 'tonies',
  'stamfordcycling.com': 'Stamford Cycling',
  'eatclub.co.uk': 'EatClub',
  'scrimpr.com': 'Scrimpr',
  'nexo.io': 'Nexo',
  'robinhood.com': 'Robinhood',
}
