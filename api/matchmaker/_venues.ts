/**
 * Hand-picked Taipei first-date spots (docs/proposals/dating-flow.md).
 * Ryo only ever proposes venues from this list, never open map search.
 *
 * DRAFT: picked for being public, well known, and long-running. Verify each
 * one (still open, right district) before real users see it, and add your own.
 */

import type { DateStyle, TaipeiDistrict } from "../../src/shared/dating.js";

export interface Venue {
  id: string;
  name: string;
  district: TaipeiDistrict;
  styles: DateStyle[];
  /** Fine in rain. */
  indoor: boolean;
  blurb: string;
}

export const TAIPEI_VENUES: Venue[] = [
  { id: "fika-fika", name: "Fika Fika Cafe", district: "zhongshan", styles: ["coffee"], indoor: true, blurb: "bright Nordic-style roastery on Yitong Street" },
  { id: "simple-kaffa", name: "Simple Kaffa Flagship", district: "zhongzheng", styles: ["coffee"], indoor: true, blurb: "award-winning baristas inside Huashan 1914" },
  { id: "huashan-1914", name: "Huashan 1914 Creative Park", district: "zhongzheng", styles: ["walk", "activity"], indoor: true, blurb: "old winery turned exhibitions, shops, and markets" },
  { id: "treasure-hill", name: "Treasure Hill Artist Village", district: "zhongzheng", styles: ["walk", "activity"], indoor: false, blurb: "hillside village of artist studios by the river" },
  { id: "songshan-cultural-park", name: "Songshan Cultural and Creative Park", district: "xinyi", styles: ["walk", "activity"], indoor: true, blurb: "tobacco factory turned design exhibitions and a pond walk" },
  { id: "elephant-mountain", name: "Elephant Mountain Trail", district: "xinyi", styles: ["walk", "activity"], indoor: false, blurb: "short steep hike with the Taipei 101 view at the top" },
  { id: "raohe-night-market", name: "Raohe Street Night Market", district: "songshan", styles: ["food", "walk"], indoor: false, blurb: "classic night market, start with the pepper buns at the gate" },
  { id: "fujin-street", name: "Fujin Street", district: "songshan", styles: ["coffee", "walk"], indoor: false, blurb: "tree-lined lanes full of small cafés and shops" },
  { id: "ningxia-night-market", name: "Ningxia Night Market", district: "datong", styles: ["food"], indoor: false, blurb: "compact night market famous for its local snacks" },
  { id: "dihua-street", name: "Dihua Street", district: "datong", styles: ["coffee", "walk"], indoor: false, blurb: "old Dadaocheng shophouses with teahouses and cafés" },
  { id: "dadaocheng-wharf", name: "Dadaocheng Wharf", district: "datong", styles: ["walk", "drinks"], indoor: false, blurb: "riverside sunsets with container bars" },
  { id: "daan-forest-park", name: "Da’an Forest Park", district: "daan", styles: ["walk"], indoor: false, blurb: "the city’s big green park, easy for a long walk" },
  { id: "draft-land", name: "Draft Land", district: "daan", styles: ["drinks"], indoor: true, blurb: "cocktails on tap, relaxed and easy to talk in" },
  { id: "taipei-fine-arts-museum", name: "Taipei Fine Arts Museum", district: "zhongshan", styles: ["activity"], indoor: true, blurb: "modern and contemporary art, good conversation starter" },
  { id: "national-palace-museum", name: "National Palace Museum", district: "shilin", styles: ["activity"], indoor: true, blurb: "world-class collection; pick one gallery, not all of it" },
  { id: "shilin-night-market", name: "Shilin Night Market", district: "shilin", styles: ["food", "walk"], indoor: false, blurb: "Taipei’s biggest night market, with an indoor food court" },
  { id: "beitou-thermal-valley", name: "Beitou Thermal Valley", district: "beitou", styles: ["walk"], indoor: false, blurb: "steaming hot-spring lake and the wooden Beitou Library" },
  { id: "dahu-park", name: "Dahu Park", district: "neihu", styles: ["walk"], indoor: false, blurb: "lake with an arched bridge, calm for a slow walk" },
  { id: "maokong", name: "Maokong Gondola and Teahouses", district: "wenshan", styles: ["activity", "drinks"], indoor: false, blurb: "gondola up to hillside teahouses with city views" },
  { id: "bopiliao", name: "Bopiliao Historic Block", district: "wanhua", styles: ["walk"], indoor: false, blurb: "restored Qing-era street, quiet and photogenic" },
  { id: "ximending", name: "Ximending", district: "wanhua", styles: ["food", "activity"], indoor: false, blurb: "busy pedestrian zone with snacks, movies, and arcades" },
];
