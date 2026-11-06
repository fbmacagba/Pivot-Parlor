/**
 * The two fictional portfolio shops, entered the way an owner would enter
 * them: settings, services, team, portraits and style notes. Nothing here is
 * a real business, person, address or phone number.
 *
 *  - Phone numbers are from Ofcom's drama ranges (020 7946 0xxx London,
 *    0117 496 0xxx Bristol), which are never allocated to real lines.
 *  - Addresses carry no street or house number: the street line reads
 *    "Illustrative address", so nothing can point at a real premises.
 *  - Staff emails use the reserved .invalid TLD and can never receive mail.
 *
 * Ids and slugs match the code-owned registry in packages/utils/src/portfolioDemo.ts.
 */

const hours = (h) => JSON.stringify({ mon: "", tue: "", wed: "", thu: "", fri: "", sat: "", sun: "", ...h });

export const DEMO_SHOPS = [
  {
    key: "ferdyms",
    id: "pp-demo-ferdyms-barber",
    slug: "ferdyms-barber-shop-demo",
    shopNumber: 9001,
    name: "FerdyM's Barber Shop",
    type: "barber_shop",
    ownerEmail: "owner@ferdyms.demo.invalid",
    designNotes:
      "Fictional demonstration shop for the Pivot Parlor portfolio. A small neighbourhood barbershop in Deptford: deep green tiles, brass fittings, warm tungsten light and vintage oxblood leather chairs. Unhurried, precise and friendly. Every price is on the menu.",
    settings: {
      address: "Illustrative address, Deptford, London SE8",
      phone: "020 7946 0123",
      hours_json: hours({
        tue: "10:00-19:00",
        wed: "10:00-19:00",
        thu: "10:00-20:00",
        fri: "10:00-20:00",
        sat: "09:00-17:00",
      }),
    },
    services: [
      { name: "Skin fade", category: "Cuts", price_pence: 2400, duration_min: 40, image: "svc-skin-fade" },
      { name: "Scissor cut", category: "Cuts", price_pence: 2600, duration_min: 45, image: "svc-scissor-cut" },
      { name: "Cut & beard", category: "Cuts", price_pence: 3500, duration_min: 60, image: "svc-cut-and-beard" },
      { name: "Kids' cut (under 12)", category: "Cuts", price_pence: 1600, duration_min: 30, image: "svc-kids-cut" },
      { name: "Beard sculpt & line-up", category: "Beard & shave", price_pence: 1500, duration_min: 20, image: "svc-beard-sculpt" },
      { name: "Hot towel shave", category: "Beard & shave", price_pence: 2200, duration_min: 30, image: "svc-hot-towel-shave" },
    ],
    staff: [
      {
        name: "Kofi Asante",
        email: "kofi@ferdyms.demo.invalid",
        speciality: "Skin fades and beard sculpting",
        portrait: "staff-kofi",
        services: ["Skin fade", "Cut & beard", "Beard sculpt & line-up", "Scissor cut"],
      },
      {
        name: "Dan Whitlock",
        email: "dan@ferdyms.demo.invalid",
        speciality: "Scissor cuts and hot towel shaves",
        portrait: "staff-dan",
        services: ["Scissor cut", "Hot towel shave", "Cut & beard", "Beard sculpt & line-up"],
      },
      {
        name: "Ruby Okafor",
        email: "ruby@ferdyms.demo.invalid",
        speciality: "Textured hair and kids' cuts",
        portrait: "staff-ruby",
        services: ["Skin fade", "Scissor cut", "Kids' cut (under 12)"],
      },
    ],
  },
  {
    key: "linden",
    id: "pp-demo-linden-lark",
    slug: "linden-and-lark-demo",
    shopNumber: 9002,
    name: "Linden & Lark Hair Studio",
    type: "beauty_parlor",
    ownerEmail: "owner@lindenlark.demo.invalid",
    designNotes:
      "Fictional demonstration salon for the Pivot Parlor portfolio. A calm daylight studio in Clifton, Bristol: ivory walls, sage velvet chairs, pale oak and tall windows. The studio focuses on soft, lived-in colour and precise cuts for curly and straight hair. Appointments start with a short consultation. Quiet, unhurried and considered.",
    settings: {
      address: "Illustrative address, Clifton, Bristol BS8",
      phone: "0117 496 0418",
      hours_json: hours({
        wed: "09:30-17:30",
        thu: "11:00-20:00",
        fri: "09:30-17:30",
        sat: "09:00-17:00",
        sun: "10:00-15:00",
      }),
    },
    services: [
      { name: "Cut & finish", category: "Cutting", price_pence: 5800, duration_min: 60, image: "svc-cut-finish" },
      { name: "Restyle consultation & cut", category: "Cutting", price_pence: 7200, duration_min: 75, image: "svc-restyle" },
      { name: "Blow-dry", category: "Styling", price_pence: 3400, duration_min: 45, image: "svc-blow-dry" },
      { name: "Balayage", category: "Colour", price_pence: 16500, duration_min: 180, image: "svc-balayage" },
      { name: "Root colour", category: "Colour", price_pence: 6800, duration_min: 90, image: "svc-root-colour" },
      { name: "Gloss toner", category: "Colour", price_pence: 3800, duration_min: 30, image: "svc-gloss" },
      { name: "Bond repair treatment", category: "Treatments", price_pence: 4500, duration_min: 45, image: "svc-bond-repair" },
    ],
    staff: [
      {
        name: "Isla Brennan",
        email: "isla@lindenlark.demo.invalid",
        speciality: "Colour and balayage",
        portrait: "staff-isla",
        services: ["Balayage", "Root colour", "Gloss toner", "Bond repair treatment", "Cut & finish"],
      },
      {
        name: "Priya Nair",
        email: "priya@lindenlark.demo.invalid",
        speciality: "Precision cutting and curly hair",
        portrait: "staff-priya",
        services: ["Cut & finish", "Restyle consultation & cut", "Blow-dry", "Bond repair treatment"],
      },
      {
        name: "Tom Ashby",
        email: "tom@lindenlark.demo.invalid",
        speciality: "Blow-dries and occasion styling",
        portrait: "staff-tom",
        services: ["Blow-dry", "Cut & finish", "Gloss toner"],
      },
    ],
  },
];

/** An ordinary tenant that must come out of every demo check untouched and
 *  without any demo labelling. Its site row is seeded directly (legacy v2). */
export const CONTROL_SHOP = {
  id: "pp-local-control",
  slug: "control-cuts-901",
  shopNumber: 9901,
  name: "Control Cuts",
  type: "barber_shop",
  ownerEmail: "owner@control.local.invalid",
  service: { name: "Standard cut", category: "Cuts", price_pence: 2000, duration_min: 30 },
  staffName: "Sam Control",
};
