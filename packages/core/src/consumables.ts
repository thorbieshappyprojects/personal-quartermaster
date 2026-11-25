/**
 * Rule-based guess whether a purchase line was a consumable: food and drink (pet food
 * included) or a household supply (toiletries, cleaning, paper, batteries, medicine).
 * Used to pre-sort the possession check; a person still decides. Exclusions win, so
 * "coffee grinder", "tea cup" or a belt in "coffee brown" are not taken for food.
 * Titles are matched in English and German; Taobao lines use their English translation.
 */
export type ConsumableKind = 'food' | 'supplies';

/** Bump when the rules change, so stored suggestions are recomputed. */
export const CONSUMABLE_RULES_VERSION = 1;

// Grocery chains and food delivery services: everything bought there is taken as food.
const FOOD_SHOPS = /\b(rewe|edeka|lidl|aldi|kaufland|netto|penny|picnic|flink|gorillas|getir|knuspr|lieferando|lieferheld|wolt|uber ?eats|deliveroo|domino'?s|pizza hut|epermarket|freshippo|hema fresh|metro)\b/i;

const sources = (xs: string[]) => new RegExp(xs.join('|'), 'i');

const FOOD = sources([
  "ovomaltine", "melisse", "kurkuma", "turmeric", "ginseng", "getrocknet", "\\bdried\\b", "katzenminze", "malven",
  "capsules", "\\bmaca\\b", "erdmandel", "chufli", "govinda", "leinsamen", "goji", "feigen", "buchweizen", "hirse",
  "quinoa", "amaranth", "stevia", "protein", "lemongrass", "lemongras", "limettenbl", "lotus leaves", "caltrop",
  "chestnuts", "prunes", "cranberries", "blueberries", "cinnamon", "erythritol", "sweetener", "pocari",
  "(coconut|flaxseed|grapeseed|walnut|avocado) oil", "salmon", "lemonade", "drip-bag", "lozenges", "pastilles",
  "throat candy", "dog food", "puppy food", "wet food", "treats", "dog chews?", "dental (dog )?chews?", "rawhide",
  "air-dried", "freeze-dried", "kangaroo (bone|rib|tail)", "mineral water", "kräutertee", "[a-zäöü]{3,}tee\\b",
  "food", "snacks?", "\\btea\\b", "teas\\b", "coffee", "espresso", "chocolate", "candy", "sweets", "cookies?",
  "biscuits?", "\\bcakes?\\b", "bread", "noodles?", "\\brice\\b", "sauce", "spices?", "seasoning", "honey",
  "\\bjam\\b", "\\bnuts\\b", "almonds?", "peanuts?", "walnuts?", "cashews?", "pistachio", "dried fruit",
  "\\bfruits?\\b", "vegetables?", "\\bbeef\\b", "\\bpork\\b", "sausage", "seafood", "shrimp", "olive oil",
  "sesame oil", "cooking oil", "\\bwine\\b", "\\bbeer\\b", "whisk(e)?y", "\\bgin\\b", "\\brum\\b", "vodka", "liquor",
  "liqueur", "baijiu", "\\bsake\\b", "juice", "mineral water", "milk powder", "\\bmilk\\b", "yogh?urt", "cheese",
  "butter", "flour", "\\bsugar\\b", "vinegar", "\\bsoup\\b", "hot ?pot (base|seasoning)", "jerky", "mooncakes?",
  "zongzi", "dumplings?", "tofu", "kimchi", "protein (powder|bar)", "\\bwhey\\b", "supplements?", "vitamins?",
  "gummies", "matcha", "oolong", "pu-?erh", "pu ?er\\b", "cocoa", "syrup", "cereal", "\\boats?\\b", "oatmeal",
  "granola", "muesli", "\\bchips\\b", "crisps", "popcorn", "pudding", "instant", "edible", "beverage", "drinks?\\b",
  "pastr(y|ies)", "chili", "pepper(corns)?\\b", "\\bsalt\\b", "\\bjelly\\b", "lebensmittel", "kaffee", "\\btee\\b",
  "tees\\b", "schokolade", "süßigkeiten", "kekse?", "gummibär", "haribo", "nüsse", "mandeln", "honig", "marmelade",
  "konfitüre", "gewürz", "pfeffer", "\\bzucker\\b", "\\bmehl\\b", "nudeln", "\\bpasta\\b", "\\breis\\b", "soße",
  "olivenöl", "\\bessig\\b", "\\bwein\\b", "rotwein", "weißwein", "\\bbier\\b", "\\bsekt\\b", "champagner", "likör",
  "\\bsaft\\b", "mineralwasser", "\\bmilch\\b", "\\bkäse\\b", "\\bwurst\\b", "fleisch", "\\bbrot\\b", "müsli",
  "haferflocken", "proteinpulver", "eiweiß", "nahrungsergänzung", "vitamin", "sirup", "kakao", "kaffeebohnen",
  "energy ?drink", "red bull", "\\bcola\\b", "club-?mate", "lakritz", "bonbons?", "kaugummi", "tiefkühl",
  "\\bpizza\\b", "burger", "\\bsushi\\b", "\\bmenü\\b", "getränk", "\\bobst\\b", "gemüse", "bananen?", "äpfel",
  "tomaten", "kartoffel", "joghurt", "quark", "sahne", "\\beier\\b", "brötchen", "snack", "riegel", "chips",
  "trüffel", "pralinen", "kapseln", "nespresso", "dolce gusto", "senseo", "pads\\b", "\\bglühwein\\b", "schnaps",
  "brand\\b", "edelbrand", "geist\\b", "pfand", "katzenfutter", "hundefutter", "futter\\b",
]);

const SUPPLIES = sources([
  "ibuprofen", "paracetamol", "tabletten", "loratadin", "ohropax", "earplugs", "ohrstöpsel", "\\bserum\\b",
  "eye cream", "face cream", "gesichtscreme", "augencreme", "tagespflege", "nachtpflege", "massage cream",
  "forming cream", "pomade", "pre.?shave", "badeöl", "bath (oil|salt)", "glaubersalz", "epsom", "nasenspülsalz",
  "nasal spray", "wipes", "laundry (liquid|gel|detergent)", "\\btide\\b", "persil", "\\bomo\\b",
  "toilet (bowl )?cleaner", "disinfectant", "mosquito repellent", "flossers", "basenpulver", "poop bags",
  "filterkartuschen", "moisturi[sz]ing", "moisturi[sz]er", "\\bcream\\b", "handseife", "shampoo", "conditioner",
  "shower gel", "duschgel", "\\bsoap\\b", "seife", "toothpaste", "zahnpasta", "zahncreme", "aufsteckbürsten",
  "brush heads", "zahnseide", "dental floss", "deodorant", "\\bdeo\\b", "sunscreen", "sonnencreme", "sonnenschutz",
  "rasierklingen", "razor blades", "klingen", "rasierschaum", "shaving (foam|gel)", "handcreme", "bodylotion",
  "body lotion", "detergent", "waschmittel", "spülmittel", "geschirrspül", "spülmaschinen",
  "dishwasher (tabs|tablets)", "weichspüler", "reiniger", "cleaner\\b", "entkalker", "descaler", "toilettenpapier",
  "toilet paper", "küchenrolle", "taschentücher", "tissues", "feuchttücher", "wet wipes", "müllbeutel", "müllsäcke",
  "garbage bags", "trash bags", "katzenstreu", "cat litter", "windeln", "diapers", "kontaktlinsen", "contact lens",
  "wattepads", "cotton pads", "filtertüten", "coffee filters?", "filterkartusche", "filter cartridges?",
  "druckerpatrone", "tintenpatrone", "\\btoner\\b", "ink cartridges?", "batterien", "\\bbatteries\\b", "teelichter",
  "tea ?lights", "ffp2", "face masks?", "masken", "kondome", "condoms", "pflaster", "plasters", "mouthwash",
  "mundspülung", "lip balm", "lippenpflege", "haarfarbe", "hair dye", "face mask sheets?", "sheet masks?",
  "duftkerze", "räucherstäbchen", "incense", "tabs\\b", "putztücher", "schwämme", "sponges",
]);

const EXCLUDE = sources([
  "doormat", "harness", "crafts", "preserved", "wiederverwendbar", "permanent", "partyplug", "muffs", "\\bseat\\b",
  "plunger", "screws", "antler", "chew (toy|ball)", "treat-dispensing", "\\bbed\\b", "seiftuch", "frottier",
  "sleep (eye )?mask", "schlafmaske", "seifensäckchen", "halloween", "balaclava", "\\bski\\b", "soap box", "putty",
  "deflector", "\\bjug\\b", "^shipping$", "atlas", "ravensburger", "nerf\\b", "hasbro", "geschichte", "netzteil",
  "wicked chili", "kapselst", "ausgabe", "headband", "candle", "stainless", "squeezer", "juicer", "\\bfelt\\b",
  "foot pads", "puck", "screen", "coffee-wood", "belt", "scissors", "sunglasses", "funnel", "\\bmat\\b", "\\bpen\\b",
  "gloves", "grater", "zester", "slicer", "chopper", "potted", "bolts", "frame", "fabric", "hardwood", "maschine",
  "machine", "mühle", "grinder", "kettle", "wasserkocher", "kocher", "\\bcups?\\b", "\\bmugs?\\b", "tassen?\\b",
  "becher", "gläser", "\\bglass(es)?\\b", "trinkflasche", "thermos", "water bottle", "öffner", "opener", "tea set",
  "teeservice", "teapot", "teekanne", "kanne", "aufbewahrung", "storage", "container", "\\brack\\b", "regal",
  "holder", "halter", "spender", "dispenser", "\\btray\\b", "tablett", "spoon", "löffel", "scoop", "sieb",
  "strainer", "infuser", "\\bbooks?\\b", "buch", "ratgeber", "poster", "\\bprint\\b", "sticker", "shirt", "hoodie",
  "lamp", "lampe", "\\btoy", "spielzeug", "plush", "figur", "\\bmodel", "kühlschrank", "fridge", "mixer", "blender",
  "toaster", "waffel", "waffle", "\\boven\\b", "\\bofen\\b", "pfanne", "\\bpan\\b", "\\bpot\\b(?! (base|seasoning))",
  "topf", "messer", "knife", "knives", "\\bscale\\b", "waage", "thermometer", "timer", "dekanter", "decanter",
  "karaffe", "shaker", "\\bmou?ld", "backform", "ausstecher", "cutter", "brett", "board", "gerät", "device",
  "electric", "elektrisch", "\\busb\\b", "cable", "kabel", "(?<!/ )\\bcase\\b", "hülle",
  "(?<!\\dg )(?<!\\dkg )\\bbag\\b",
  "\\b(tote|hand|shoulder|toiletry|document|storage|gym|camera|laptop|cosmetic|sleeping) bags\\b", "tasche",
  "rucksack", "backpack", "schrank", "cabinet", "\\btable\\b", "tisch", "chair", "stuhl", "sofa", "decorat", "deko",
  "ornament", "magnet", "keychain", "anhänger", "pendant", "costume", "kostüm", "\\bsign\\b", "schild",
  "plant(er)?\\b", "pflanze", "\\bseeds?\\b", "samen", "pillow", "kissen", "blanket", "decke", "towel", "handtuch",
  "tray", "basket", "korb", "brush\\b(?! heads)", "bürste(?!n)", "pump", "pumpe", "sprayer", "bottle opener",
  "press\\b", "maker", "brewer", "kit\\b", "zubehör", "accessor", "adapter", "ladegerät", "charger", "watch",
  "uhr\\b", "ring\\b", "necklace", "kette", "earring", "figure", "puzzle", "game\\b", "spiel\\b", "lego", "clothing",
  "kleid", "dress\\b", "jacket", "jacke", "hose\\b", "pants", "shoes?\\b", "schuh", "socks?", "socken", "hat\\b",
  "mütze", "tray", "dish(es)?\\b(?!washer)", "teller", "plate", "(?<!toilet )bowl", "schüssel", "schale",
  "chopsticks", "stäbchen(?!räucher)", "set\\b(?! of)", "tinplate", "can opener", "warmer", "wärmer", "canister",
  "jar\\b", "glas\\b", "shelf", "stand\\b", "ständer", "labels?\\b", "etikett", "tea towel", "apron", "schürze",
  "sieve", "\\bwhisk\\b", "tongs", "zange", "refill(able)?\\b(?! (pack|pouch))", "nachfüllbar", "spray bottle",
  "organizer", "cover\\b", "abdeckung", "perfume bottle", "diffuser", "humidifier", "luftbefeuchter", "heater",
  "cooler", "kühler", "ice cube", "eiswürfel", "freezer", "gefrier", "vacuum", "sauger", "vacuum sealer", "cushion",
]);

export function classifyConsumable(line: { title: string; titleTranslated?: string | null; merchant?: string | null }): ConsumableKind | null {
  const text = line.titleTranslated || line.title;
  if (EXCLUDE.test(text)) return null;
  if (line.merchant && FOOD_SHOPS.test(line.merchant)) return 'food';
  if (FOOD.test(text)) return 'food';
  if (SUPPLIES.test(text)) return 'supplies';
  return null;
}
