export const UK_STRONG_SIGNALS = [
  'United Kingdom', 'UK', 'GB', 'Great Britain',
  'England', 'Scotland', 'Wales', 'Northern Ireland',
  'FCA', 'FSCS', 'PRA', 'Financial Conduct Authority',
  'eligible UK residents', 'UK only', 'UK residents only',
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow',
  'Edinburgh', 'Liverpool', 'Bristol', 'Cardiff', 'Belfast',
]

export const UK_DOMAIN_TLDS = [
  '.co.uk', '.uk', '.london', '.scot', '.wales', '.cymru',
  '.org.uk', '.me.uk', '.ac.uk', '.gov.uk', '.nhs.uk',
]

export const NON_UK_TLDS = ['.de', '.fr', '.com.au', '.ca', '.nz', '.it', '.es', '.nl', '.be', '.ie', '.jp', '.cn']

export const US_CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
  'San Francisco', 'San Diego', 'Dallas', 'Austin', 'Miami',
  'Seattle', 'Boston', 'Denver', 'Portland', 'Atlanta',
]

export const UK_CITIES = [
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow',
  'Edinburgh', 'Liverpool', 'Bristol', 'Cardiff', 'Belfast',
  'Sheffield', 'Newcastle', 'Nottingham', 'Southampton', 'Brighton',
]

export type UkSignalStrength = 'strong' | 'moderate' | 'pound_only' | 'weak' | 'unknown' | 'discard'

export function parseCurrencyToGbp(value: string): number | null {
  const gbpMatch = value.match(/£\s*(\d+\.?\d*)/)
  if (gbpMatch?.[1]) return parseFloat(gbpMatch[1])

  const poundTextMatch = value.match(/(\d+)\s*(?:pounds?|quid)/i)
  if (poundTextMatch?.[1]) return parseFloat(poundTextMatch[1])

  const wordNumbers: Record<string, number> = {
    'ten': 10, 'tenner': 10, 'twenty': 20, 'thirty': 30, 'forty': 40,
    'fifty': 50, 'hundred': 100, 'five': 5, 'fiver': 5, 'one': 1,
  }
  for (const [word, num] of Object.entries(wordNumbers)) {
    if (value.toLowerCase().includes(word)) return num
  }

  const usdMatch = value.match(/\$\s*(\d+\.?\d*)/)
  if (usdMatch?.[1]) return parseFloat(usdMatch[1]) * 0.78

  return null
}
