/**
 * Prompts behind every showcase image (tools/showcase/assets). The images were
 * generated from exactly these strings with FLUX.1 [schnell] (Apache-2.0); see
 * assets/PROVENANCE.json for the per-file source, seed and sha256.
 *
 * Rules the prompts follow: adults only; clients clothed and caped; no
 * children (the kids' cut is a still life); no text, signage, framed pictures
 * or logos; every person is AI-generated and depicts no real individual.
 *
 * Row shape: [shopKey, fileName, width, height, prompt].
 */
export const NO = ", no text, no lettering, no signage, no posters, no framed pictures, no logos, no watermark";
export const BARBER = ", deep green tiled wall, brass fittings, warm tungsten light, 35mm film photograph, natural skin texture";
export const SALON = ", bright ivory salon, sage green accents, soft natural daylight from tall windows, medium format film photograph, natural skin texture";

export const IMAGE_JOBS = [
  // FerdyM's Barber Shop (fictional, Deptford): dark green, tungsten, brass.
  ["ferdyms", "hero", 1344, 768, `Editorial photograph inside a small independent London barbershop at dusk, an adult barber in a dark canvas apron over a black t-shirt finishing a skin fade with clippers on an adult man in his thirties wearing a black barber cape, seated in a vintage oxblood leather barber chair, shallow depth of field, the pair on the right third of the frame, calm and focused${BARBER}${NO}`],
  ["ferdyms", "svc-skin-fade", 1024, 1024, `Close-up photograph of the back and side of an adult man's head with a fresh sharp skin fade haircut, black barber cape at the neck, face not visible${BARBER}${NO}`],
  ["ferdyms", "svc-scissor-cut", 1024, 1024, `Close-up photograph of a barber's hands holding a comb and scissors trimming the textured hair of an adult man wearing a black barber cape, face out of frame${BARBER}${NO}`],
  ["ferdyms", "svc-beard-sculpt", 1024, 1024, `Side profile photograph of an adult man in his thirties with a neatly sculpted full beard and a crisp line-up, black barber cape${BARBER}${NO}`],
  ["ferdyms", "svc-hot-towel-shave", 1024, 1024, `Photograph of an adult man reclined in a vintage leather barber chair with a steaming white hot towel wrapped over his face, black barber cape covering him to the neck, a straight razor and shaving brush on a brass tray beside the chair${BARBER}${NO}`],
  ["ferdyms", "svc-cut-and-beard", 1024, 1024, `Photograph of an adult man in his forties with a fresh short haircut and a groomed beard, seen in a round barbershop mirror, wearing a black barber cape${BARBER}${NO}`],
  ["ferdyms", "svc-kids-cut", 1024, 1024, `Still life photograph of a small wooden booster seat resting on a vintage leather barber chair, a comb and round-tipped scissors on the arm rest, no people${BARBER}${NO}`],
  ["ferdyms", "gallery-room", 1024, 768, `Photograph of the empty interior of an independent barbershop, two vintage oxblood leather barber chairs facing round brass mirrors, walnut counter, no people${BARBER}${NO}`],
  ["ferdyms", "gallery-tools", 1024, 768, `Close-up still life of barber tools on a walnut counter, straight razor, clippers, brass-handled comb and a shaving brush, shallow depth of field, no labels${BARBER}${NO}`],
  ["ferdyms", "gallery-chair", 1024, 768, `Photograph of a single vintage oxblood leather barber chair in front of a round brass-framed mirror, no people${BARBER}${NO}`],
  ["ferdyms", "staff-kofi", 832, 1024, `Editorial head and shoulders portrait photograph of a Ghanaian British man barber in his late thirties with a short beard, wearing a dark green work shirt and a canvas apron, friendly confident expression, barbershop softly blurred behind${BARBER}${NO}`],
  ["ferdyms", "staff-dan", 832, 1024, `Editorial head and shoulders portrait photograph of a white British man barber in his early thirties with short neat hair and light stubble, wearing a white short-sleeved shirt buttoned up and a dark canvas apron, warm expression, plain deep green tiled wall behind him with nothing hung on it, softly blurred${BARBER}${NO}`],
  ["ferdyms", "staff-ruby", 832, 1024, `Editorial head and shoulders portrait photograph of a Nigerian British woman barber in her late twenties with short natural coily hair, wearing a black crew-neck t-shirt and a dark canvas apron, relaxed smile, barbershop softly blurred behind${BARBER}${NO}`],
  // Linden & Lark Hair Studio (fictional, Bristol): ivory, sage, daylight.
  ["linden", "hero", 1344, 768, `Editorial photograph in a bright minimal hair salon, an adult woman stylist in a cream top blow-drying the long glossy brunette hair of an adult woman client in her thirties wearing a sage salon gown, the pair on the right of the frame, airy negative space on the left${SALON}${NO}`],
  ["linden", "svc-cut-finish", 1024, 1024, `Photograph of an adult woman in her thirties with a fresh shoulder-length cut, seen from behind and slightly to one side, wearing a sage salon gown${SALON}${NO}`],
  ["linden", "svc-restyle", 1024, 1024, `Photograph of a stylist's hands sectioning the long hair of an adult woman client in a sage salon gown during a consultation, faces out of frame${SALON}${NO}`],
  ["linden", "svc-blow-dry", 1024, 1024, `Photograph of an adult woman seen from behind with freshly blow-dried smooth voluminous shoulder-length brunette hair worn loose and down, not tied up, wearing a sage salon gown, a round brush resting on the counter${SALON}${NO}`],
  ["linden", "svc-balayage", 1024, 1024, `Close-up photograph of long wavy hair with a soft caramel balayage on an adult woman seen from behind, wearing a sage salon gown${SALON}${NO}`],
  ["linden", "svc-root-colour", 1024, 1024, `Photograph of a colourist's gloved hands applying colour to the roots of an adult woman's dark hair with a tint brush, small ceramic mixing bowl, sage salon gown, faces out of frame${SALON}${NO}`],
  ["linden", "svc-gloss", 1024, 1024, `Close-up photograph of very shiny glossy honey blonde hair on an adult woman seen from behind, wearing a sage salon gown, hair catching the light${SALON}${NO}`],
  ["linden", "svc-bond-repair", 1024, 1024, `Still life photograph of unlabelled amber glass treatment bottles, a wide-tooth comb and a folded linen towel on a pale oak shelf, no people, no labels${SALON}${NO}`],
  ["linden", "gallery-room", 1024, 768, `Photograph of the empty interior of a bright minimal hair salon, two sage velvet styling chairs facing tall arched mirrors, pale oak floor, potted plants, no people${SALON}${NO}`],
  ["linden", "gallery-basin", 1024, 768, `Photograph of a white ceramic backwash basin and a sage chair in a calm salon washroom, folded linen towels, no people${SALON}${NO}`],
  ["linden", "gallery-shelf", 1024, 768, `Still life photograph of unlabelled amber bottles and dried grasses in a ceramic vase on a pale oak shelf, no people, no labels${SALON}${NO}`],
  ["linden", "staff-isla", 832, 1024, `Editorial head and shoulders portrait photograph of a Scottish woman hair colourist in her late thirties with shoulder-length auburn hair, wearing a cream linen shirt, calm warm expression, salon softly blurred behind${SALON}${NO}`],
  ["linden", "staff-priya", 832, 1024, `Editorial head and shoulders portrait photograph of a British Indian woman hairdresser in her early thirties with long dark curly hair, wearing a sage knit top, gentle smile, salon softly blurred behind${SALON}${NO}`],
  ["linden", "staff-tom", 832, 1024, `Editorial head and shoulders portrait photograph of a Black British man hair stylist in his early thirties with short locs, wearing an oatmeal knit jumper, friendly expression, salon softly blurred behind${SALON}${NO}`],
];

/** The prompt an asset was generated from, or undefined. */
export function promptFor(shopKey, name) {
  return IMAGE_JOBS.find(([s, n]) => s === shopKey && n === name)?.[4];
}