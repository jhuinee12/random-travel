import { useState, useRef, useEffect, useCallback } from "react";
import { REGIONS, type Region, type District, type Destination } from "./data/korea";
import {
  haversine, centroid,
  formatDistance, estimateTime, bearing, pick,
} from "./utils/geo";
import { loadKakaoMapsSdk } from "./utils/kakao";

// ── TRANSPORT DATA ──
const TRANSPORTS = [
  { key: "plane", label: "비행기", emoji: "✈️", type: "public" },
  { key: "boat", label: "배", emoji: "🚢", type: "public" },
  { key: "ktx", label: "KTX", emoji: "🚄", type: "public" },
  { key: "rail", label: "일반열차", emoji: "🚂", type: "public" },
  { key: "subway", label: "지하철", emoji: "🚇", type: "public" },
  { key: "bus", label: "버스", emoji: "🚌", type: "public" },
  { key: "expressBus", label: "고속버스", emoji: "🚌", type: "public" },
  { key: "intercityBus", label: "시외버스", emoji: "🚍", type: "public" },
  { key: "car", label: "자가용", emoji: "🚗", type: "private" },
  { key: "bicycle", label: "자전거", emoji: "🚲", type: "private" },
  { key: "walk", label: "걷기", emoji: "🚶", type: "private" },
];

interface TransportHub {
  name: string;
  lat: number;
  lng: number;
  types: string[];
  address?: string;
  placeUrl?: string;
}

type KakaoPlace = {
  name: string;
  lat: number;
  lng: number;
  address: string;
  roadAddress: string;
  categoryName: string;
  placeUrl?: string;
};

type TransportSearchConfig = {
  hubKeywords: string[];
  destinationKeywords: string[];
  hubCategoryCode?: string;
};

const TRANSPORT_SPEED_KMH: Record<string, number> = {
  plane: 500,
  boat: 30,
  ktx: 210,
  rail: 110,
  subway: 40,
  bus: 30,
  expressBus: 85,
  intercityBus: 70,
  car: 80,
  bicycle: 15,
  walk: 4,
};

const TRANSPORT_SEARCH_CONFIG: Record<string, TransportSearchConfig> = {
  plane: {
    hubKeywords: ["공항", "국제공항"],
    destinationKeywords: ["관광지", "명소", "해변", "국립공원", "테마파크"],
  },
  boat: {
    hubKeywords: ["여객터미널", "항", "항만"],
    destinationKeywords: ["섬 관광지", "해변", "항구 관광지", "바다 전망대"],
  },
  ktx: {
    hubKeywords: ["KTX역", "기차역"],
    destinationKeywords: ["관광지", "명소", "박물관", "자연휴양림", "전통시장"],
  },
  rail: {
    hubKeywords: ["기차역", "역"],
    destinationKeywords: ["관광지", "명소", "박물관", "공원", "전망대"],
  },
  subway: {
    hubKeywords: ["지하철역", "전철역", "역"],
    destinationKeywords: ["핫플", "전시관", "공원", "맛집거리", "카페거리"],
  },
  bus: {
    hubKeywords: ["버스환승센터", "버스정류장", "버스터미널"],
    destinationKeywords: ["관광지", "핫플", "시장", "공원", "전시관"],
  },
  expressBus: {
    hubKeywords: ["고속버스터미널"],
    destinationKeywords: ["관광지", "명소", "시장", "공원", "테마파크"],
  },
  intercityBus: {
    hubKeywords: ["시외버스터미널", "버스터미널"],
    destinationKeywords: ["관광지", "명소", "시장", "공원", "전망대"],
  },
  car: {
    hubKeywords: [],
    destinationKeywords: ["드라이브 코스", "관광지", "명소", "휴양림", "호수공원"],
  },
  bicycle: {
    hubKeywords: [],
    destinationKeywords: ["자전거길", "강변", "공원", "카페거리", "산책로"],
  },
  walk: {
    hubKeywords: [],
    destinationKeywords: ["산책로", "공원", "카페거리", "전시관", "야경 명소"],
  },
};

function getDurationHours(duration: string): number {
  if (duration === "2박 3일") return 30;
  if (duration === "1박 2일") return 16;
  return 8;
}

function getDistanceWindowKm(transportKey: string, duration: string): { minKm: number; maxKm: number; targetKm: number } {
  const speed = TRANSPORT_SPEED_KMH[transportKey] ?? 60;
  const hours = getDurationHours(duration);
  const transportType = TRANSPORTS.find((t) => t.key === transportKey)?.type ?? "private";
  const hardCaps: Record<string, number> = {
    walk: 24,
    bicycle: 120,
    subway: 180,
    bus: 140,
  };
  const hardCap = hardCaps[transportKey] ?? 900;
  const maxKm = Math.max(2, Math.min(hardCap, speed * hours));
  const minRatio = transportType === "public" ? 0.22 : 0.08;
  const minFloor = transportType === "public" ? 12 : 0.5;
  const minKm = Math.min(maxKm * 0.85, Math.max(minFloor, maxKm * minRatio));
  return { minKm, maxKm, targetKm: (minKm + maxKm) / 2 };
}

function getLastMileLimitKm(transportKey: string): number {
  const speed = TRANSPORT_SPEED_KMH[transportKey] ?? 50;
  return Math.max(3, Math.min(45, speed * 0.3));
}

function placeKeyOf(place: { name: string; lat: number; lng: number }): string {
  return `${place.name}__${place.lat.toFixed(5)}__${place.lng.toFixed(5)}`;
}

function parseRegion(address: string): string {
  const token = address.trim().split(/\s+/)[0];
  return token || "위치 기반";
}

function toDestination(place: KakaoPlace, transportLabel: string): Destination {
  const address = place.roadAddress || place.address || "";
  const region = parseRegion(address);
  const categoryToken = place.categoryName ? place.categoryName.split(">").pop()?.trim() : "";
  const tags = [transportLabel, categoryToken || "실시간 검색", region].filter(Boolean);
  return {
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    region,
    description: address ? `${address} 기반 추천 목적지` : "실시간 검색 기반 추천 목적지",
    tags: tags.slice(0, 3),
  };
}

function getKakaoRestApiKey(): string {
  const key = import.meta.env.VITE_KAKAO_REST_API_KEY?.trim();
  if (!key) throw new Error("missing_kakao_rest_api_key");
  return key;
}

async function searchKakaoKeyword(query: string, opts?: {
  lat?: number;
  lng?: number;
  radiusMeters?: number;
  page?: number;
  size?: number;
  sort?: "accuracy" | "distance";
  categoryGroupCode?: string;
}): Promise<KakaoPlace[]> {
  const key = getKakaoRestApiKey();
  const params = new URLSearchParams({
    query,
    page: String(opts?.page ?? 1),
    size: String(opts?.size ?? 15),
    sort: opts?.sort ?? "accuracy",
  });
  if (opts?.lat !== undefined && opts?.lng !== undefined) {
    params.set("x", String(opts.lng));
    params.set("y", String(opts.lat));
  }
  if (opts?.radiusMeters !== undefined) {
    params.set("radius", String(Math.max(500, Math.min(20000, Math.round(opts.radiusMeters)))));
  }
  if (opts?.categoryGroupCode) {
    params.set("category_group_code", opts.categoryGroupCode);
  }

  const res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`, {
    headers: { Authorization: `KakaoAK ${key}` },
  });
  if (!res.ok) {
    throw new Error(`kakao_rest_${res.status}`);
  }
  const data = await res.json() as { documents?: any[] };
  const docs = data.documents ?? [];
  return docs
    .map((doc) => {
      const lat = Number(doc.y);
      const lng = Number(doc.x);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        name: String(doc.place_name ?? ""),
        lat,
        lng,
        address: String(doc.address_name ?? ""),
        roadAddress: String(doc.road_address_name ?? ""),
        categoryName: String(doc.category_name ?? ""),
        placeUrl: typeof doc.place_url === "string" ? doc.place_url : undefined,
      } as KakaoPlace;
    })
    .filter((item): item is KakaoPlace => item !== null && item.name.length > 0);
}

// ── SPIN (여행지 현장) CATEGORIES ──
const CATEGORY_META: Record<string, { label: string; emoji: string; radius: number; color: string; bg: string }> = {
  food: { label: "음식", emoji: "🍜", radius: 1.5, color: "#FF6B6B", bg: "#fff5f5" },
  cafe: { label: "카페", emoji: "☕", radius: 1.5, color: "#FF9F43", bg: "#fff9f0" },
  attraction: { label: "관광지", emoji: "🏛️", radius: 5, color: "#26de81", bg: "#f0fff6" },
  activity: { label: "액티비티", emoji: "🎡", radius: 5, color: "#45aaf2", bg: "#f0f8ff" },
  lodging: { label: "숙박", emoji: "🛏️", radius: 8, color: "#0ea5e9", bg: "#eef8ff" },
  nextTown: { label: "다음 동네", emoji: "🗺️", radius: 30, color: "#a55eea", bg: "#f8f0ff" },
  nightView: { label: "야경", emoji: "🌃", radius: 8, color: "#1d4ed8", bg: "#eff6ff" },
  kidFriendly: { label: "아이동반", emoji: "🧸", radius: 6, color: "#f97316", bg: "#fff7ed" },
  indoor: { label: "실내", emoji: "🏠", radius: 4, color: "#0f766e", bg: "#ecfeff" },
  date: { label: "데이트", emoji: "💑", radius: 5, color: "#db2777", bg: "#fdf2f8" },
};

const DEFAULT_CATEGORY_RADII: Record<string, number> = {
  food: 3,
  cafe: 3,
  attraction: 5,
  activity: 5,
  lodging: 5,
  nextTown: 8,
  nightView: 8,
  kidFriendly: 6,
  indoor: 4,
  date: 5,
};
const CANDIDATE_CACHE_TTL_MS = 5 * 60 * 1000;

const KAKAO_CATEGORY_KEYWORDS: Record<string, string[]> = {
  food: ["맛집", "음식점", "한식"],
  cafe: ["카페", "디저트 카페", "브런치 카페"],
  attraction: ["관광지", "명소", "박물관"],
  activity: ["체험", "레저", "액티비티"],
  lodging: ["호텔", "펜션", "게스트하우스"],
  nextTown: ["버스터미널", "기차역", "읍사무소"],
  nightView: ["야경 명소", "전망대", "루프탑"],
  kidFriendly: ["키즈카페", "테마파크", "동물원"],
  indoor: ["실내 관광지", "박물관", "전시관"],
  date: ["데이트 코스", "감성 카페", "전망 좋은 곳"],
};

type CategoryTheme = {
  key: string;
  label: string;
  keywords: string[];
  categoryTokens?: string[];
};

const KAKAO_CATEGORY_GROUP_BY_CAT: Record<string, string | undefined> = {
  food: "FD6",
  cafe: "CE7",
  lodging: "AD5",
  attraction: "AT4",
};

const CATEGORY_THEMES: Record<string, CategoryTheme[]> = {
  food: [
    { key: "all", label: "전체", keywords: ["맛집", "음식점", "한식"] },
    { key: "korean", label: "한식", keywords: ["한식 맛집", "백반", "국밥"], categoryTokens: ["한식"] },
    { key: "japanese", label: "일식", keywords: ["일식", "초밥", "라멘"], categoryTokens: ["일식"] },
    { key: "chinese", label: "중식", keywords: ["중식", "중화요리", "짜장면"], categoryTokens: ["중식"] },
    { key: "western", label: "양식", keywords: ["파스타", "스테이크", "이탈리안"], categoryTokens: ["양식", "이탈리안"] },
    { key: "snack", label: "분식", keywords: ["분식", "떡볶이", "김밥"], categoryTokens: ["분식"] },
    { key: "meat", label: "고기", keywords: ["고기집", "삼겹살", "갈비"], categoryTokens: ["고기", "육류"] },
    { key: "seafood", label: "해산물", keywords: ["해산물", "횟집", "조개구이"], categoryTokens: ["해물", "수산", "회"] },
    { key: "chicken", label: "치킨", keywords: ["치킨", "닭강정", "통닭"], categoryTokens: ["치킨"] },
    { key: "bar", label: "술집", keywords: ["술집", "포장마차", "이자카야"], categoryTokens: ["주점", "술집", "호프", "와인", "이자카야", "포차"] },
  ],
  attraction: [
    { key: "all", label: "전체", keywords: ["관광지", "명소", "박물관"] },
    { key: "nature", label: "자연", keywords: ["공원", "해변", "산책로"] },
    { key: "history", label: "역사", keywords: ["유적지", "문화재", "전통마을"] },
    { key: "museum", label: "전시", keywords: ["박물관", "미술관", "전시관"] },
    { key: "photo", label: "포토", keywords: ["포토스팟", "전망대", "인생샷"] },
  ],
  activity: [
    { key: "all", label: "전체", keywords: ["체험", "레저", "액티비티"] },
    { key: "sports", label: "스포츠", keywords: ["클라이밍", "볼링장", "스포츠센터"] },
    { key: "water", label: "수상", keywords: ["카약", "서핑", "수상레저"] },
    { key: "craft", label: "공방", keywords: ["공방 체험", "원데이클래스", "도예 체험"] },
    { key: "kids", label: "가족", keywords: ["체험관", "키즈 체험", "테마파크"] },
  ],
  lodging: [
    { key: "all", label: "전체", keywords: ["호텔", "펜션", "게스트하우스"] },
    { key: "hotel", label: "호텔", keywords: ["비즈니스 호텔", "부티크 호텔", "시티호텔"] },
    { key: "pension", label: "펜션", keywords: ["감성 펜션", "독채 펜션", "풀빌라"] },
    { key: "hanok", label: "한옥", keywords: ["한옥스테이", "전통 숙소", "고택 숙소"] },
    { key: "cost", label: "가성비", keywords: ["가성비 숙소", "모텔", "저렴한 숙소"] },
  ],
};

function getThemeByKey(cat: string, themeKey?: string | null): CategoryTheme | null {
  if (!themeKey) return null;
  const themes = CATEGORY_THEMES[cat];
  if (!themes) return null;
  return themes.find((theme) => theme.key === themeKey) ?? null;
}

// ── STEPS ──
type Step = "home" | "input" | "settings" | "planning" | "plan_result" | "travel" | "spinning" | "spin_result";

// ── COLOR PALETTE ──
const P = {
  purple: "#7c3aed", purpleLight: "#ede9fe", purpleMid: "#a78bfa",
  pink: "#ec4899", dark: "#1e1b4b", gray: "#6b7280",
  lightGray: "#f9fafb", border: "#e5e7eb", white: "#ffffff",
};

// ── Participant ──
interface Participant {
  id: number;
  regionIdx: number | null;
  districtIdx: number | null;
  dongIdx: number | null;
}

function getParticipantCoords(p: Participant): { lat: number; lng: number } | null {
  if (p.regionIdx === null || p.districtIdx === null) return null;
  const region = REGIONS[p.regionIdx];
  if (!region) return null;
  const district = region.districts[p.districtIdx];
  if (!district) return null;
  return { lat: district.lat, lng: district.lng };
}

function getParticipantLabel(p: Participant): string {
  if (p.regionIdx === null) return "";
  const region = REGIONS[p.regionIdx];
  if (!region) return "";
  let label = region.name;
  if (p.districtIdx !== null) {
    label += " " + region.districts[p.districtIdx]?.name;
  }
  if (p.dongIdx !== null && p.districtIdx !== null) {
    const dong = region.districts[p.districtIdx]?.dongs[p.dongIdx];
    if (dong) label += " " + dong.name;
  }
  return label;
}

function getSortedNameIndexPairs(items: { name: string }[]): Array<{ idx: number; name: string }> {
  return items
    .map((item, idx) => ({ idx, name: item.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"));
}

function getRadiusMaxKm(cat: string): number {
  if (cat === "food" || cat === "cafe" || cat === "lodging" || cat === "indoor") return 10;
  if (cat === "kidFriendly" || cat === "date") return 15;
  return 20;
}

async function collectKeywordPlaces(
  keywords: string[],
  opts: {
    lat?: number;
    lng?: number;
    radiusMeters?: number;
    categoryGroupCode?: string;
    pages?: number;
    sort?: "accuracy" | "distance";
  }
): Promise<KakaoPlace[]> {
  const pages = Math.max(1, opts.pages ?? 1);
  const tasks: Array<Promise<KakaoPlace[]>> = [];
  for (const keyword of keywords) {
    for (let page = 1; page <= pages; page += 1) {
      tasks.push(searchKakaoKeyword(keyword, {
        lat: opts.lat,
        lng: opts.lng,
        radiusMeters: opts.radiusMeters,
        categoryGroupCode: opts.categoryGroupCode,
        page,
        size: 15,
        sort: opts.sort ?? "accuracy",
      }));
    }
  }
  const settled = await Promise.allSettled(tasks);
  const merged = settled
    .filter((result): result is PromiseFulfilledResult<KakaoPlace[]> => result.status === "fulfilled")
    .flatMap((result) => result.value);
  const uniq = new Map<string, KakaoPlace>();
  for (const place of merged) {
    const key = placeKeyOf(place);
    if (!uniq.has(key)) uniq.set(key, place);
  }
  return Array.from(uniq.values());
}

async function fetchOriginHubs(
  center: { lat: number; lng: number },
  transportKey: string
): Promise<TransportHub[]> {
  const config = TRANSPORT_SEARCH_CONFIG[transportKey];
  if (!config || config.hubKeywords.length === 0) return [];
  const places = await collectKeywordPlaces(config.hubKeywords, {
    lat: center.lat,
    lng: center.lng,
    radiusMeters: 20000,
    categoryGroupCode: config.hubCategoryCode,
    pages: 2,
    sort: "distance",
  });
  return places.slice(0, 20).map((place) => ({
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    types: [transportKey],
    address: place.roadAddress || place.address,
    placeUrl: place.placeUrl,
  }));
}

async function fetchDestinationPool(
  origin: { lat: number; lng: number },
  transportKey: string,
  windowKm: { minKm: number; maxKm: number }
): Promise<KakaoPlace[]> {
  const config = TRANSPORT_SEARCH_CONFIG[transportKey];
  if (!config) return [];
  const nearby = await collectKeywordPlaces(config.destinationKeywords, {
    lat: origin.lat,
    lng: origin.lng,
    radiusMeters: 20000,
    pages: 2,
    sort: "distance",
  });
  const nationwide = await collectKeywordPlaces(config.destinationKeywords, {
    pages: 2,
    sort: "accuracy",
  });
  return [...nearby, ...nationwide]
    .filter((place) => {
      const km = haversine(origin.lat, origin.lng, place.lat, place.lng);
      return km >= windowKm.minKm && km <= windowKm.maxKm;
    })
    .sort((a, b) => {
      const aKm = haversine(origin.lat, origin.lng, a.lat, a.lng);
      const bKm = haversine(origin.lat, origin.lng, b.lat, b.lng);
      return aKm - bKm;
    });
}

async function findBestArrivalHub(
  destination: { lat: number; lng: number },
  transportKey: string
): Promise<{ hub: TransportHub; lastMileKm: number } | null> {
  const config = TRANSPORT_SEARCH_CONFIG[transportKey];
  if (!config || config.hubKeywords.length === 0) return null;
  const maxLastMile = getLastMileLimitKm(transportKey);
  const places = await collectKeywordPlaces(config.hubKeywords, {
    lat: destination.lat,
    lng: destination.lng,
    radiusMeters: Math.round(maxLastMile * 1000),
    pages: 1,
    sort: "distance",
  });
  const candidates = places
    .map((place) => ({
      hub: {
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        types: [transportKey],
        address: place.roadAddress || place.address,
        placeUrl: place.placeUrl,
      },
      lastMileKm: haversine(destination.lat, destination.lng, place.lat, place.lng),
    }))
    .filter((item) => item.lastMileKm <= maxLastMile)
    .sort((a, b) => a.lastMileKm - b.lastMileKm);
  return candidates[0] ?? null;
}

// ── Plan Result ──
interface PlanResult {
  transport: typeof TRANSPORTS[number];
  hub: TransportHub | null; // 출발 집합장소
  arrivalHub: TransportHub | null; // 도착 허브 (대중교통)
  destination: Destination;
  distFromHub: number;
  distFromCentroid: number;
  departTime: string;
  estimatedTime: string;
  tip: string;
}

interface SavedPlanItem {
  id: number;
  createdAt: string;
  transportLabel: string;
  transportEmoji: string;
  destinationName: string;
  destinationRegion: string;
  hubName: string | null;
  estimatedTime: string;
  distance: string;
}

interface SpinCandidate {
  name: string;
  address?: string;
  distanceKm?: number;
  lat?: number;
  lng?: number;
  placeUrl?: string;
  popularity?: number;
}

// ── UI ATOMS ──
const Btn = ({ children, onClick, variant = "primary", disabled, small, style: ext }: {
  children: React.ReactNode; onClick?: () => void; variant?: string; disabled?: boolean; small?: boolean; style?: React.CSSProperties;
}) => {
  const base: React.CSSProperties = { border: "none", borderRadius: "14px", cursor: disabled ? "not-allowed" : "pointer", fontWeight: "700", transition: "all 0.15s", opacity: disabled ? 0.5 : 1, fontSize: small ? "13px" : "15px", padding: small ? "8px 16px" : "13px 20px" };
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: `linear-gradient(135deg,${P.purple},${P.pink})`, color: P.white, width: "100%" },
    secondary: { background: P.lightGray, color: P.gray, width: "100%", border: `1px solid ${P.border}` },
    outline: { background: P.white, color: P.purple, border: `2px solid ${P.purple}` },
    ghost: { background: "transparent", color: P.gray, padding: "6px 12px" },
  };
  return <button style={{ ...base, ...variants[variant], ...ext }} onClick={onClick} disabled={disabled}>{children}</button>;
};

const Card = ({ children, style: ext }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ background: P.white, borderRadius: "20px", padding: "20px", boxShadow: "0 2px 16px rgba(0,0,0,0.08)", ...ext }}>{children}</div>
);

const Tag = ({ children, color = P.purple }: { children: React.ReactNode; color?: string }) => (
  <span style={{ background: color + "20", color, fontSize: "11px", fontWeight: "700", padding: "3px 10px", borderRadius: "20px" }}>{children}</span>
);

const Chip = ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => (
  <button onClick={onClick} style={{ padding: "7px 14px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", cursor: "pointer", border: `2px solid ${active ? P.purple : P.border}`, background: active ? P.purpleLight : P.white, color: active ? P.purple : P.gray }}>{label}</button>
);

const LoadingDots = () => (
  <div style={{ display: "flex", gap: "6px", justifyContent: "center", margin: "20px 0" }}>
    {[0, 1, 2].map(i => (
      <div key={i} style={{ width: "10px", height: "10px", borderRadius: "50%", background: `linear-gradient(135deg,${P.purple},${P.pink})`, animation: `bounce 0.8s ${i * 0.15}s ease-in-out infinite alternate` }} />
    ))}
    <style>{`@keyframes bounce{from{transform:translateY(0)}to{transform:translateY(-10px)}}`}</style>
  </div>
);

const Roulette = ({ items, finalIdx, spinning, onDone }: { items: string[]; finalIdx: number; spinning: boolean; onDone: () => void }) => {
  const [cur, setCur] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    if (!spinning || !items.length) return;
    let count = 0;
    ref.current = setInterval(() => {
      setCur(c => (c + 1) % items.length);
      if (++count > 40) { clearInterval(ref.current); setCur(finalIdx); setTimeout(() => onDone(), 400); }
    }, 80);
    return () => clearInterval(ref.current);
  }, [spinning]);
  return (
    <div style={{ textAlign: "center", padding: "20px 0" }}>
      <div style={{ fontSize: "18px", fontWeight: "800", color: P.dark, background: P.purpleLight, borderRadius: "16px", padding: "16px 24px", minHeight: "60px", display: "flex", alignItems: "center", justifyContent: "center", border: `3px solid ${spinning ? P.purpleMid : P.purple}`, boxShadow: spinning ? `0 0 20px ${P.purpleMid}` : "none" }}>
        {items[cur]}
      </div>
    </div>
  );
};

const wrap = (children: React.ReactNode) => (
  <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f0ebff 0%,#fce4f6 100%)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "16px" }}>
    <div style={{ width: "100%", maxWidth: "480px", paddingBottom: "40px" }}>{children}</div>
  </div>
);

// ── SelectableList: 스크롤 가능한 선택 목록 ──
const SelectableList = ({ items, selectedIdx, onSelect, columns = 3 }: {
  items: string[]; selectedIdx: number | null; onSelect: (i: number) => void; columns?: number;
}) => (
  <div style={{ maxHeight: "160px", overflowY: "auto", display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: "5px", padding: "8px", background: P.lightGray, borderRadius: "10px" }}>
    {items.map((item, i) => (
      <button key={i} onClick={() => onSelect(i)} style={{
        padding: "6px 8px", borderRadius: "16px", fontSize: "12px",
        fontWeight: selectedIdx === i ? "700" : "500", cursor: "pointer",
        border: `2px solid ${selectedIdx === i ? P.purple : "transparent"}`,
        background: selectedIdx === i ? P.purple : P.white,
        color: selectedIdx === i ? P.white : P.dark,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{item}</button>
    ))}
  </div>
);

const MapPicker = ({
  center,
  selected,
  onPick,
}: {
  center: { lat: number; lng: number };
  selected: { lat: number; lng: number } | null;
  onPick: (coords: { lat: number; lng: number }) => void;
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const clickHandlerRef = useRef<((mouseEvent: any) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initMap = async () => {
      const kakao = await loadKakaoMapsSdk();
      if (cancelled || !ref.current || mapRef.current) return;
      mapRef.current = new kakao.maps.Map(ref.current, {
        center: new kakao.maps.LatLng(center.lat, center.lng),
        level: 4,
      });
      clickHandlerRef.current = (mouseEvent: any) => {
        const latLng = mouseEvent.latLng;
        onPick({ lat: latLng.getLat(), lng: latLng.getLng() });
      };
      kakao.maps.event.addListener(mapRef.current, "click", clickHandlerRef.current);
    };
    initMap().catch(() => void 0);
    return () => {
      cancelled = true;
      const kakao = (window as any).kakao;
      if (mapRef.current && clickHandlerRef.current && kakao?.maps?.event) {
        kakao.maps.event.removeListener(mapRef.current, "click", clickHandlerRef.current);
      }
      if (markerRef.current) markerRef.current.setMap(null);
      markerRef.current = null;
      mapRef.current = null;
      clickHandlerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    const kakao = (window as any).kakao;
    if (!kakao?.maps) return;
    if (selected) {
      const pos = new kakao.maps.LatLng(selected.lat, selected.lng);
      if (!markerRef.current) markerRef.current = new kakao.maps.Marker({ position: pos, map: mapRef.current });
      else markerRef.current.setPosition(pos);
      mapRef.current.setCenter(pos);
      mapRef.current.setLevel(3);
    } else {
      mapRef.current.setCenter(new kakao.maps.LatLng(center.lat, center.lng));
      mapRef.current.setLevel(4);
      if (markerRef.current) {
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
    }
  }, [selected, center.lat, center.lng]);

  return <div ref={ref} style={{ width: "100%", height: "280px", borderRadius: "12px", overflow: "hidden", border: `1px solid ${P.border}` }} />;
};

// ── MAIN APP ──
export default function App() {
  const PLAN_HISTORY_KEY = "randomTravel.planHistory.v1";
  const SPIN_HISTORY_KEY = "randomTravel.spinHistory.v1";

  const [step, setStep] = useState<Step>("home");
  const [participants, setParticipants] = useState<Participant[]>([{ id: 1, regionIdx: null, districtIdx: null, dongIdx: null }]);
  const [settings, setSettings] = useState({ duration: "당일치기", time: "09:00", transports: [] as string[], randomDest: true });
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planMsg, setPlanMsg] = useState("");
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsErr, setGpsErr] = useState(false);
  const [gpsErrMsg, setGpsErrMsg] = useState("");
  const [gpsAccuracyM, setGpsAccuracyM] = useState<number | null>(null);
  const [travelLocationMode, setTravelLocationMode] = useState<"gps" | "manual">("gps");
  const [manualPoint, setManualPoint] = useState<{ lat: number; lng: number } | null>(null);

  // 여행 모드 (spin)
  const [spinCat, setSpinCat] = useState<string | null>(null);
  const [spinItems, setSpinItems] = useState<string[]>([]);
  const [spinCandidates, setSpinCandidates] = useState<SpinCandidate[]>([]);
  const [spinFinalIdx, setSpinFinalIdx] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinResult, setSpinResult] = useState<{
    pickedName: string; pickedDesc: string; distance: string; direction: string;
    rating: string; candidates: SpinCandidate[]; pickedIdx: number; source: "real" | "pool"; subLabel?: string; noMatch?: boolean;
  } | null>(null);
  const [history, setHistory] = useState<Array<{ cat: string; name: string; distance: string; rating: string; time: string }>>([]);
  const [savedPlans, setSavedPlans] = useState<SavedPlanItem[]>([]);
  const [shareMsg, setShareMsg] = useState("");
  const [currentAddr, setCurrentAddr] = useState<string>("");
  const [selectedConfigCat, setSelectedConfigCat] = useState<string | null>(null);
  const [categoryRadii, setCategoryRadii] = useState<Record<string, number>>({ ...DEFAULT_CATEGORY_RADII });
  const [categoryThemeKeys, setCategoryThemeKeys] = useState<Record<string, string>>({
    food: "all",
    attraction: "all",
    activity: "all",
    lodging: "all",
  });
  const nearbyCacheRef = useRef<Map<string, { at: number; items: SpinCandidate[] }>>(new Map());

  useEffect(() => {
    try {
      const rawPlans = localStorage.getItem(PLAN_HISTORY_KEY);
      if (rawPlans) {
        const parsedPlans = JSON.parse(rawPlans) as SavedPlanItem[];
        if (Array.isArray(parsedPlans)) setSavedPlans(parsedPlans);
      }
      const rawSpinHistory = localStorage.getItem(SPIN_HISTORY_KEY);
      if (rawSpinHistory) {
        const parsedHistory = JSON.parse(rawSpinHistory) as Array<{ cat: string; name: string; distance: string; rating: string; time: string }>;
        if (Array.isArray(parsedHistory)) setHistory(parsedHistory);
      }
    } catch {
      // Ignore invalid localStorage values.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PLAN_HISTORY_KEY, JSON.stringify(savedPlans));
    } catch {
      // Ignore localStorage write errors.
    }
  }, [savedPlans]);

  useEffect(() => {
    try {
      localStorage.setItem(SPIN_HISTORY_KEY, JSON.stringify(history));
    } catch {
      // Ignore localStorage write errors.
    }
  }, [history]);

  useEffect(() => {
    const inTravelFlow = step === "travel" || step === "spinning" || step === "spin_result";
    if (inTravelFlow) return;

    // 화면 이탈 시 여행 모드 관련 상태 초기화
    setSelectedConfigCat(null);
    setCategoryRadii({ ...DEFAULT_CATEGORY_RADII });
    setSpinCat(null);
    setSpinItems([]);
    setSpinCandidates([]);
    setSpinFinalIdx(0);
    setIsSpinning(false);
    setSpinResult(null);
  }, [step]);

  // ── Participant helpers ──
  const updateP = (id: number, updates: Partial<Participant>) => {
    setParticipants(ps => ps.map(p => p.id === id ? { ...p, ...updates } : p));
  };

  const toggleTransport = (key: string) => {
    setSettings(s => ({
      ...s,
      transports: s.transports.includes(key) ? s.transports.filter(k => k !== key) : [...s.transports, key],
    }));
  };

  const getGPS = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsErr(true);
      setGpsErrMsg("이 브라우저는 위치 서비스를 지원하지 않습니다.");
      return;
    }

    const onSuccess = (pos: GeolocationPosition) => {
      setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setGpsAccuracyM(Math.round(pos.coords.accuracy));
      setGpsErr(false);
      setGpsErrMsg("");
    };

    const onError = (err: GeolocationPositionError) => {
      const fallbackOpts: PositionOptions = {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 5 * 60 * 1000,
      };
      navigator.geolocation.getCurrentPosition(
        onSuccess,
        (fallbackErr) => {
          setGpsErr(true);
          if (fallbackErr.code === 1) setGpsErrMsg("위치 권한이 거부되었습니다. 브라우저에서 위치 권한을 허용해 주세요.");
          else if (fallbackErr.code === 2) setGpsErrMsg("위치 정보를 찾지 못했습니다. 실내/와이파이 환경에서 부정확할 수 있습니다.");
          else setGpsErrMsg("위치 요청 시간이 초과되었습니다. 다시 시도해 주세요.");
        },
        fallbackOpts
      );
      if (err.code === 1) {
        setGpsErrMsg("정확한 위치 권한이 필요합니다. 브라우저 위치 권한을 확인해 주세요.");
      }
    };

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
  }, []);

  const activeTravelCoords = travelLocationMode === "manual" ? manualPoint : gps;
  const isManualReady = manualPoint !== null;

  const fetchCurrentAddress = useCallback(async (lat: number, lng: number) => {
    const kakao = await loadKakaoMapsSdk();
    const geocoder = new kakao.maps.services.Geocoder();
    const addr = await new Promise<string>((resolve) => {
      geocoder.coord2Address(lng, lat, (result: any, status: string) => {
        if (status !== kakao.maps.services.Status.OK || !result?.[0]) {
          resolve("");
          return;
        }
        const first = result[0];
        resolve(
          first.road_address?.address_name ||
          first.address?.region_3depth_name ||
          first.address?.address_name ||
          ""
        );
      });
    });
    setCurrentAddr(addr);
  }, []);

  useEffect(() => {
    if (travelLocationMode === "manual") {
      if (!manualPoint) {
        setCurrentAddr("");
        return;
      }
      fetchCurrentAddress(manualPoint.lat, manualPoint.lng).catch(() => setCurrentAddr(""));
      return;
    }
    if (!gps) {
      setCurrentAddr("");
      return;
    }
    fetchCurrentAddress(gps.lat, gps.lng).catch(() => setCurrentAddr(""));
  }, [gps, fetchCurrentAddress, travelLocationMode, manualPoint]);

  const fetchNearbyCandidates = useCallback(async (
    cat: string,
    lat: number,
    lng: number,
    opts?: { radiusMeters?: number; themeKey?: string | null }
  ): Promise<SpinCandidate[]> => {
    const requestedRadiusMeters = Math.min(
      20000,
      Math.max(500, opts?.radiusMeters ?? Math.round((categoryRadii[cat] ?? CATEGORY_META[cat]?.radius ?? 5) * 1000))
    );
    const kakao = await loadKakaoMapsSdk();
    const places = new kakao.maps.services.Places();
    const center = new kakao.maps.LatLng(lat, lng);
    const selectedTheme = getThemeByKey(cat, opts?.themeKey);
    const keywords = selectedTheme?.keywords ?? KAKAO_CATEGORY_KEYWORDS[cat] ?? [CATEGORY_META[cat]?.label ?? "명소"];
    const groupCode = KAKAO_CATEGORY_GROUP_BY_CAT[cat];
    const searchRadiusMeters = Math.min(20000, Math.max(1000, requestedRadiusMeters));

    const runKeywordSearch = (keyword: string): Promise<any[]> =>
      new Promise((resolve, reject) => {
        places.keywordSearch(
          keyword,
          (data: any[], status: string) => {
            if (status === kakao.maps.services.Status.OK) resolve(data ?? []);
            else if (status === kakao.maps.services.Status.ZERO_RESULT) resolve([]);
            else reject(new Error(`kakao_keyword_search_${status}`));
          },
          {
            location: center,
            radius: searchRadiusMeters,
            sort: kakao.maps.services.SortBy.DISTANCE,
            size: 15,
            ...(groupCode ? { category_group_code: groupCode } : {}),
          }
        );
      });

    const settled = await Promise.allSettled(keywords.map((keyword) => runKeywordSearch(keyword)));
    const rows = settled
      .filter((result): result is PromiseFulfilledResult<any[]> => result.status === "fulfilled")
      .flatMap((result) => result.value);
    if (rows.length === 0) {
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    }
    const mapped: Array<SpinCandidate | null> = rows.map((row) => {
        const categoryName = String(row.category_name ?? "");
        if (selectedTheme?.categoryTokens?.length) {
          const matched = selectedTheme.categoryTokens.some((token) => categoryName.includes(token));
          if (!matched) return null;
        }
        const pLat = Number(row.y);
        const pLng = Number(row.x);
        if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) return null;
        const fallbackDistanceKm = haversine(lat, lng, pLat, pLng);
        const distanceKm = row.distance ? Number(row.distance) / 1000 : fallbackDistanceKm;
        if (!Number.isFinite(distanceKm) || distanceKm > requestedRadiusMeters / 1000) return null;
        return {
          name: row.place_name,
          address: row.road_address_name || row.address_name || "",
          distanceKm,
          lat: pLat,
          lng: pLng,
          placeUrl: row.place_url,
          popularity: Math.max(0, 5 - distanceKm),
        };
      });
    const out = mapped.filter((item): item is SpinCandidate => item !== null);

    const uniq = new Map<string, SpinCandidate>();
    for (const c of out) {
      // 동일 프랜차이즈명을 좌표 없이 합쳐버리면 후보가 과도하게 줄어들기 때문에 좌표를 키에 포함.
      const latKey = c.lat !== undefined ? c.lat.toFixed(5) : "";
      const lngKey = c.lng !== undefined ? c.lng.toFixed(5) : "";
      const key = `${c.name}__${latKey}__${lngKey}`;
      if (!uniq.has(key)) uniq.set(key, c);
    }
    const arr = Array.from(uniq.values());
    if (cat === "attraction" || cat === "activity" || cat === "nextTown") {
      return arr
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || (a.distanceKm ?? 999) - (b.distanceKm ?? 999))
        .slice(0, 50);
    }
    return arr
      .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999))
      .slice(0, 50);
  }, [categoryRadii]);

  const buildPlanShareText = (p: PlanResult) => {
    const lines = [
      "🎲 랜덤 여행 계획",
      `이동수단: ${p.transport.emoji} ${p.transport.label}`,
      `목적지: ${p.destination.name} (${p.destination.region})`,
      p.hub ? `집합장소: ${p.hub.name}` : "집합장소: 참가자 중심 출발",
      p.arrivalHub ? `도착 허브: ${p.arrivalHub.name}` : "도착 허브: 목적지 직접 이동",
      `예상 소요: ${p.estimatedTime}`,
      `이동 거리: ${formatDistance(p.hub ? p.distFromHub : p.distFromCentroid)}`,
      `출발 시간: ${p.departTime}`,
    ];
    return lines.join("\n");
  };

  const saveCurrentPlan = () => {
    if (!plan) return;
    const item: SavedPlanItem = {
      id: Date.now(),
      createdAt: new Date().toLocaleString("ko-KR"),
      transportLabel: plan.transport.label,
      transportEmoji: plan.transport.emoji,
      destinationName: plan.destination.name,
      destinationRegion: plan.destination.region,
      hubName: plan.hub?.name ?? null,
      estimatedTime: plan.estimatedTime,
      distance: formatDistance(plan.hub ? plan.distFromHub : plan.distFromCentroid),
    };
    setSavedPlans(prev => [item, ...prev].slice(0, 20));
    setShareMsg("✅ 계획을 저장했어요");
    setTimeout(() => setShareMsg(""), 1800);
  };

  const shareCurrentPlan = async () => {
    if (!plan) return;
    const text = buildPlanShareText(plan);
    try {
      if (navigator.share) {
        await navigator.share({ title: "랜덤 여행 계획", text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("share_not_supported");
      }
      setShareMsg("✅ 공유 문구를 준비했어요");
    } catch {
      setShareMsg("⚠️ 공유 실패 (브라우저 권한 확인)");
    } finally {
      setTimeout(() => setShareMsg(""), 2200);
    }
  };

  const allParticipantCoords = participants
    .map(getParticipantCoords)
    .filter((c): c is { lat: number; lng: number } => c !== null);

  const isInputComplete = participants.some(p => p.regionIdx !== null && p.districtIdx !== null && p.dongIdx !== null);

  // ── 여행 계획 생성 (위치 기반) ──
  const generatePlan = async () => {
    setStep("planning");
    const msgs = ["📍 참가자 위치 분석 중...", "🧮 최적 출발지 계산 중...", "🗺️ 위치 기반 목적지 탐색 중...", "✨ 최종 계획 완성 중..."];
    for (const m of msgs) { setPlanMsg(m); await new Promise(r => setTimeout(r, 700)); }

    // 1) 랜덤 이동수단 선택
    const selectedTransports = TRANSPORTS.filter(t => settings.transports.includes(t.key));
    if (selectedTransports.length === 0) {
      setStep("settings");
      return;
    }
    const pickedTransport = pick(selectedTransports);
    const isPublic = pickedTransport.type === "public";

    // 2) 참가자 중심점
    const center = centroid(allParticipantCoords);
    const distanceWindow = getDistanceWindowKm(pickedTransport.key, settings.duration);

    // 3) 집합장소 + 목적지 전역 최적화
    let hub: TransportHub | null = null;
    let selectedRoute: { destination: Destination; arrivalHub: TransportHub | null; routeKm: number } | null = null;
    try {
      if (isPublic) {
        const fetchedHubs = await fetchOriginHubs(center, pickedTransport.key);
        const candidateHubs = fetchedHubs.slice(0, 6);
        const scoredPlans: Array<{
          score: number;
          originHub: TransportHub | null;
          destination: Destination;
          routeKm: number;
        }> = [];

        for (const originHub of candidateHubs) {
          const origin = { lat: originHub.lat, lng: originHub.lng };
          const accessDists = allParticipantCoords.length > 0
            ? allParticipantCoords.map((p) => haversine(p.lat, p.lng, origin.lat, origin.lng))
            : [haversine(center.lat, center.lng, origin.lat, origin.lng)];
          const accessSum = accessDists.reduce((sum, d) => sum + d, 0);
          const accessMax = Math.max(...accessDists);
          const accessMin = Math.min(...accessDists);
          const accessGap = accessMax - accessMin;

          const destPool = await fetchDestinationPool(origin, pickedTransport.key, distanceWindow);
          if (destPool.length === 0) continue;
          const uniqByPlace = new Map<string, KakaoPlace>();
          for (const place of destPool) {
            const key = placeKeyOf(place);
            if (!uniqByPlace.has(key)) uniqByPlace.set(key, place);
          }
          const shortlisted = Array.from(uniqByPlace.values())
            .sort((a, b) => {
              const aKm = haversine(origin.lat, origin.lng, a.lat, a.lng);
              const bKm = haversine(origin.lat, origin.lng, b.lat, b.lng);
              return Math.abs(aKm - distanceWindow.targetKm) - Math.abs(bKm - distanceWindow.targetKm);
            })
            .slice(0, 14);

          for (const place of shortlisted) {
            const routeKm = haversine(origin.lat, origin.lng, place.lat, place.lng);
            const distancePenalty = Math.abs(routeKm - distanceWindow.targetKm);
            const score = accessSum * 1.15 + accessMax * 0.85 + accessGap * 0.45 + routeKm * 0.5 + distancePenalty * 0.65;
            scoredPlans.push({
              score,
              originHub,
              destination: toDestination(place, pickedTransport.label),
              routeKm,
            });
          }
        }

        if (scoredPlans.length > 0) {
          const best = [...scoredPlans].sort((a, b) => a.score - b.score)[0];
          hub = best.originHub;
          selectedRoute = {
            destination: best.destination,
            arrivalHub: null,
            routeKm: best.routeKm,
          };
          const arrival = await findBestArrivalHub(best.destination, pickedTransport.key);
          if (arrival) {
            selectedRoute.arrivalHub = arrival.hub;
            selectedRoute.routeKm += arrival.lastMileKm;
          }
        }
      }

      const origin = hub ? { lat: hub.lat, lng: hub.lng } : center;

      if (!selectedRoute) {
        const destPool = await fetchDestinationPool(origin, pickedTransport.key, distanceWindow);
        if (destPool.length === 0) {
          throw new Error("no_live_destination_found");
        }
        const ranked = destPool
          .sort((a, b) => {
            const aKm = haversine(origin.lat, origin.lng, a.lat, a.lng);
            const bKm = haversine(origin.lat, origin.lng, b.lat, b.lng);
            return Math.abs(aKm - distanceWindow.targetKm) - Math.abs(bKm - distanceWindow.targetKm);
          })
          .slice(0, 18);
        const pickedPlace = pick(ranked.slice(0, Math.min(6, ranked.length)));
        const destination = toDestination(pickedPlace, pickedTransport.label);
        const directKm = haversine(origin.lat, origin.lng, destination.lat, destination.lng);
        let arrivalHub: TransportHub | null = null;
        let totalKm = directKm;
        if (isPublic) {
          const arrival = await findBestArrivalHub(destination, pickedTransport.key);
          if (arrival) {
            arrivalHub = arrival.hub;
            totalKm += arrival.lastMileKm;
          }
        }
        selectedRoute = {
          destination,
          arrivalHub,
          routeKm: totalKm,
        };
      }

      const distFromCenter = haversine(center.lat, center.lng, selectedRoute.destination.lat, selectedRoute.destination.lng);
      const estTime = estimateTime(selectedRoute.routeKm, pickedTransport.key);

      const tips = [
        "미리 간식 챙겨가세요 🍫", "날씨 앱 꼭 확인!", "보조배터리 필수 🔋",
        "편한 신발 추천 👟", "현금도 조금 챙기세요 💰", "사진 많이 찍어요 📸",
        "시간표는 아래 검색 버튼으로 바로 확인 가능해요 🕒", "현지 맛집 검색은 필수 🔍",
      ];

      setPlan({
        transport: pickedTransport,
        hub,
        arrivalHub: selectedRoute.arrivalHub,
        destination: selectedRoute.destination,
        distFromHub: selectedRoute.routeKm,
        distFromCentroid: distFromCenter,
        departTime: settings.time,
        estimatedTime: estTime,
        tip: pick(tips),
      });
      setStep("plan_result");
    } catch (err) {
      console.error(err);
      setStep("settings");
      window.alert("실시간 검색 기반 계획 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  // ── GPS 기반 랜덤 스핀 ──
  const startSpin = async (cat: string) => {
    setSpinCat(cat);
    setSpinResult(null);
    setIsSpinning(false);
    setSpinItems([]);
    setSpinCandidates([]);
    setSpinFinalIdx(0);
    setStep("spinning");

    let source: "real" | "pool" = "pool";
    let candidates: SpinCandidate[] = [];
    let subLabel = "";
    let searchError: string | null = null;
    const selectedThemeKey = categoryThemeKeys[cat] ?? null;
    const selectedTheme = getThemeByKey(cat, selectedThemeKey);
    const radiusKm = categoryRadii[cat] ?? CATEGORY_META[cat]?.radius ?? 5;
    const cacheKey = activeTravelCoords
      ? `${cat}:${selectedThemeKey ?? "none"}:${activeTravelCoords.lat.toFixed(4)},${activeTravelCoords.lng.toFixed(4)}:${radiusKm.toFixed(1)}`
      : null;
    if (activeTravelCoords) {
      try {
        const nearby = await fetchNearbyCandidates(cat, activeTravelCoords.lat, activeTravelCoords.lng, {
          radiusMeters: Math.round(radiusKm * 1000),
          themeKey: selectedThemeKey,
        });
        if (nearby.length > 0) {
          candidates = nearby;
          source = "real";
          subLabel = `${selectedTheme ? `${selectedTheme.label} 테마 · ` : ""}후보 ${nearby.length}곳 중 랜덤`;
          if (cacheKey) nearbyCacheRef.current.set(cacheKey, { at: Date.now(), items: nearby });
        } else if (cacheKey) {
          const cached = nearbyCacheRef.current.get(cacheKey);
          if (cached && Date.now() - cached.at <= CANDIDATE_CACHE_TTL_MS && cached.items.length > 0) {
            candidates = cached.items;
            source = "real";
            subLabel = `${selectedTheme ? `${selectedTheme.label} 테마 · ` : ""}후보 ${cached.items.length}곳 중 랜덤 (이전 조회값 재사용)`;
          }
        }
      } catch (err) {
        searchError = err instanceof Error ? err.message : "kakao_api_unknown_error";
        if (cacheKey) {
          const cached = nearbyCacheRef.current.get(cacheKey);
          if (cached && Date.now() - cached.at <= CANDIDATE_CACHE_TTL_MS && cached.items.length > 0) {
            candidates = cached.items;
            source = "real";
            subLabel = `${selectedTheme ? `${selectedTheme.label} 테마 · ` : ""}후보 ${cached.items.length}곳 중 랜덤 (조회 불안정으로 캐시 사용)`;
          }
        }
      }
    }

    if (candidates.length === 0 && activeTravelCoords) {
      const isLikelyConfigError = searchError?.includes("missing_kakao_javascript_key")
        || searchError?.includes("kakao_sdk")
        || searchError?.includes("kakao_keyword_search_ERROR");
      setSpinResult({
        pickedName: isLikelyConfigError ? "카카오 API 호출에 실패했어요" : "조건에 맞는 장소가 없어요",
        pickedDesc: isLikelyConfigError
          ? "도메인 등록/키 설정 문제일 수 있습니다. 콘솔 에러를 확인해 주세요."
          : `${selectedTheme ? `${selectedTheme.label} 테마로 ` : ""}설정한 반경(${radiusKm}km) 내 후보를 찾지 못했습니다.`,
        distance: "-",
        direction: "-",
        rating: "-",
        candidates: [],
        pickedIdx: -1,
        source: "real",
        subLabel: isLikelyConfigError
          ? `오류 코드: ${searchError ?? "unknown"}`
          : "반경을 넓혀 다시 시도해 주세요.",
        noMatch: true,
      });
      setStep("spin_result");
      return;
    }

    if (candidates.length === 0) {
      setSpinResult({
        pickedName: "주변 후보를 찾지 못했어요",
        pickedDesc: activeTravelCoords
          ? `${selectedTheme ? `${selectedTheme.label} 테마로 ` : ""}설정한 반경(${radiusKm}km) 내 카카오 검색 결과가 없습니다.`
          : "GPS 또는 직접 위치 선택 후 다시 시도해 주세요.",
        distance: "-",
        direction: "-",
        rating: "-",
        candidates: [],
        pickedIdx: -1,
        source: "real",
        subLabel: "반경을 넓히거나 카테고리를 바꿔 다시 시도해 주세요.",
        noMatch: true,
      });
      setStep("spin_result");
      return;
    }

    const finalIdx = Math.floor(Math.random() * candidates.length);
    const picked = candidates[finalIdx];

    // GPS 기반 거리/방향 계산
    const meta = CATEGORY_META[cat];
    const dist = (activeTravelCoords && picked.lat !== undefined && picked.lng !== undefined)
      ? haversine(activeTravelCoords.lat, activeTravelCoords.lng, picked.lat, picked.lng)
      : picked.distanceKm ?? (Math.random() * meta.radius * 0.8 + meta.radius * 0.1);
    const dir = (activeTravelCoords && picked.lat !== undefined && picked.lng !== undefined)
      ? bearing(activeTravelCoords, { lat: picked.lat, lng: picked.lng })
      : (() => {
        const randomAngle = Math.random() * 360;
        const dirs = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
        return dirs[Math.round(randomAngle / 45) % 8];
      })();
    const ratings = ["3.8", "4.0", "4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"];

    setSpinCandidates(candidates);
    setSpinItems(candidates.map((c) => c.name));
    setSpinFinalIdx(finalIdx);
    setSpinResult({
      candidates,
      pickedIdx: finalIdx,
      pickedName: picked.name,
      pickedDesc: activeTravelCoords
        ? `${source === "real" ? "실제 주변 장소" : "주변 추천"} · ${dir}쪽 ${formatDistance(dist)}`
        : `주변 추천 ${meta.label}`,
      distance: formatDistance(dist),
      direction: dir,
      rating: pick(ratings),
      source,
      subLabel: subLabel || undefined,
    });
    setIsSpinning(true);
  };

  const onSpinDone = () => {
    setIsSpinning(false);
    setStep("spin_result");
    if (spinResult) {
      setHistory(h => [{
        cat: spinCat!, name: spinResult.pickedName,
        distance: spinResult.distance, rating: spinResult.rating,
        time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
      }, ...h]);
    }
  };

  // ── HOME ──
  if (step === "home") return wrap(
    <div style={{ paddingTop: "40px" }}>
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <div style={{ fontSize: "72px" }}>🎲</div>
        <h1 style={{ fontSize: "34px", fontWeight: "900", color: P.dark, margin: "8px 0 6px", letterSpacing: "-1px" }}>랜덤 여행</h1>
        <p style={{ color: P.gray, fontSize: "15px", lineHeight: "1.6" }}>어디 갈지 고민은 그만!<br /><b>위치 기반</b>으로 현실적인 여행을 뽑아드려요 ✨</p>
      </div>
      <button onClick={() => setStep("input")} style={{ width: "100%", marginBottom: "14px", padding: "24px 20px", background: `linear-gradient(135deg,${P.purple},#5b21b6)`, border: "none", borderRadius: "20px", cursor: "pointer", textAlign: "left", boxShadow: `0 4px 20px ${P.purple}40` }}>
        <div style={{ fontSize: "32px", marginBottom: "8px" }}>🧳</div>
        <div style={{ fontSize: "18px", fontWeight: "900", color: "white", marginBottom: "4px" }}>여행 준비 중이에요</div>
        <div style={{ fontSize: "13px", color: "rgba(255,255,255,0.75)", lineHeight: "1.6" }}>출발지 선택 (시/도 → 시/군/구 → 읍/면/동)<br />위치 기반 집합장소 & 목적지 랜덤 결정</div>
      </button>
      <button onClick={() => { setStep("travel"); getGPS(); }} style={{ width: "100%", padding: "24px 20px", background: `linear-gradient(135deg,${P.pink},#be185d)`, border: "none", borderRadius: "20px", cursor: "pointer", textAlign: "left", boxShadow: `0 4px 20px ${P.pink}40` }}>
        <div style={{ fontSize: "32px", marginBottom: "8px" }}>📍</div>
        <div style={{ fontSize: "18px", fontWeight: "900", color: "white", marginBottom: "4px" }}>이미 여행지에 있어요</div>
        <div style={{ fontSize: "13px", color: "rgba(255,255,255,0.75)", lineHeight: "1.6" }}>GPS 기반 현재 위치 파악<br />음식 · 카페 · 관광지 · 액티비티 랜덤 결정</div>
      </button>
    </div>
  );

  // ── INPUT ──
  if (step === "input") return wrap(
    <div style={{ paddingTop: "20px" }}>
      <Btn variant="ghost" small onClick={() => setStep("home")} style={{ marginBottom: "12px" }}>← 홈으로</Btn>
      <h2 style={{ fontSize: "24px", fontWeight: "800", color: P.dark, marginBottom: "4px" }}>📍 출발지 선택</h2>
      <p style={{ color: P.gray, fontSize: "14px", marginBottom: "20px" }}>시/도 → 시/군/구 → 읍/면/동 순서로 선택하세요</p>

      <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "12px" }}>
        {participants.map((p, pi) => {
          const region: Region | null = p.regionIdx !== null ? REGIONS[p.regionIdx] : null;
          const district: District | null = region && p.districtIdx !== null ? region.districts[p.districtIdx] : null;
          const sortedDistricts = region ? getSortedNameIndexPairs(region.districts) : [];
          const sortedDongs = district ? getSortedNameIndexPairs(district.dongs) : [];
          return (
            <Card key={p.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <Tag color={P.purple}>참가자 {pi + 1}</Tag>
                {participants.length > 1 && (
                  <button onClick={() => setParticipants(ps => ps.filter(x => x.id !== p.id))} style={{ background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: "18px" }}>✕</button>
                )}
              </div>

              {/* ① 시/도 */}
              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "12px", fontWeight: "600", color: P.gray, marginBottom: "6px" }}>① 시 / 도</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {REGIONS.map((r, ri) => (
                    <button key={ri} onClick={() => updateP(p.id, { regionIdx: p.regionIdx === ri ? null : ri, districtIdx: null, dongIdx: null })}
                      style={{ padding: "5px 12px", borderRadius: "20px", fontSize: "12px", fontWeight: "600", cursor: "pointer", border: `2px solid ${p.regionIdx === ri ? P.purple : P.border}`, background: p.regionIdx === ri ? P.purpleLight : P.white, color: p.regionIdx === ri ? P.purple : P.gray }}>
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* ② 시/군/구 */}
              {region && (
                <div style={{ marginBottom: "10px" }}>
                  <div style={{ fontSize: "12px", fontWeight: "600", color: P.gray, marginBottom: "6px" }}>② 시 / 군 / 구</div>
                  <SelectableList
                    items={sortedDistricts.map(d => d.name)}
                    selectedIdx={sortedDistricts.findIndex(d => d.idx === p.districtIdx)}
                    onSelect={(i) => updateP(p.id, { districtIdx: sortedDistricts[i]?.idx ?? null, dongIdx: null })}
                    columns={3}
                  />
                </div>
              )}

              {/* ③ 읍/면/동 */}
              {district && district.dongs.length > 0 && (
                <div style={{ marginBottom: "10px" }}>
                  <div style={{ fontSize: "12px", fontWeight: "600", color: P.gray, marginBottom: "6px" }}>③ 읍 / 면 / 동</div>
                  <SelectableList
                    items={sortedDongs.map(d => d.name)}
                    selectedIdx={sortedDongs.findIndex(d => d.idx === p.dongIdx)}
                    onSelect={(i) => updateP(p.id, { dongIdx: sortedDongs[i]?.idx ?? null })}
                    columns={3}
                  />
                </div>
              )}

              {/* 선택 완료 표시 */}
              {p.dongIdx !== null && (
                <div style={{ marginTop: "8px", background: P.purpleLight, borderRadius: "10px", padding: "8px 12px", fontSize: "13px", color: P.purple, fontWeight: "700" }}>
                  ✅ 참가자 {pi + 1} — {getParticipantLabel(p)}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {participants.length < 6 && (
        <Btn variant="secondary" onClick={() => setParticipants(ps => [...ps, { id: Date.now(), regionIdx: null, districtIdx: null, dongIdx: null }])} style={{ marginBottom: "14px" }}>＋ 참가자 추가</Btn>
      )}
      <Btn disabled={!isInputComplete} onClick={() => setStep("settings")}>다음 →</Btn>
    </div>
  );

  // ── SETTINGS ──
  if (step === "settings") {
    const selectedMeta = TRANSPORTS.filter(t => settings.transports.includes(t.key));
    const hasPublic = selectedMeta.some(t => t.type === "public");
    const hasPrivate = selectedMeta.some(t => t.type === "private");

    // 참가자 간 거리 표시
    const center = centroid(allParticipantCoords);
    const maxDist = allParticipantCoords.length > 1
      ? Math.max(...allParticipantCoords.map(c => haversine(center.lat, center.lng, c.lat, c.lng)))
      : 0;

    return wrap(
      <div style={{ paddingTop: "20px" }}>
        <Btn variant="ghost" small onClick={() => setStep("input")} style={{ marginBottom: "12px" }}>← 뒤로</Btn>
        <h2 style={{ fontSize: "24px", fontWeight: "800", color: P.dark, marginBottom: "4px" }}>⚙️ 여행 설정</h2>
        <p style={{ color: P.gray, fontSize: "14px", marginBottom: "20px" }}>여행 조건을 선택해주세요</p>

        {/* 참가자 위치 요약 */}
        <Card style={{ marginBottom: "14px", background: P.purpleLight }}>
          <div style={{ fontWeight: "700", color: P.purple, marginBottom: "8px", fontSize: "14px" }}>📍 참가자 위치</div>
          {participants.filter(p => p.dongIdx !== null).map((p, i) => (
            <div key={p.id} style={{ fontSize: "13px", color: P.dark, marginBottom: "4px" }}>
              참가자 {i + 1}: {getParticipantLabel(p)}
            </div>
          ))}
          {allParticipantCoords.length > 1 && (
            <div style={{ fontSize: "12px", color: P.purple, marginTop: "8px", borderTop: `1px solid ${P.purpleMid}30`, paddingTop: "8px" }}>
              📏 참가자 간 최대 거리: {formatDistance(maxDist * 2)}
            </div>
          )}
        </Card>

        {/* 여행 수단 */}
        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontWeight: "700", color: P.dark, marginBottom: "4px", fontSize: "14px" }}>🚗 여행 수단 <span style={{ color: P.gray, fontWeight: "400", fontSize: "12px" }}>(복수 선택)</span></div>
          <div style={{ fontSize: "12px", color: P.gray, marginBottom: "10px" }}>선택한 수단 중 하나를 랜덤으로 뽑아요!</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "8px", marginBottom: "10px" }}>
            {TRANSPORTS.map(t => {
              const on = settings.transports.includes(t.key);
              return (
                <button key={t.key} onClick={() => toggleTransport(t.key)} style={{ padding: "10px 4px", borderRadius: "12px", border: `2px solid ${on ? P.purple : P.border}`, background: on ? P.purpleLight : P.white, cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: "22px" }}>{t.emoji}</div>
                  <div style={{ fontSize: "11px", fontWeight: "700", color: on ? P.purple : P.gray, marginTop: "3px" }}>{t.label}</div>
                </button>
              );
            })}
          </div>
          {settings.transports.length > 0 && (
            <div style={{ background: P.lightGray, borderRadius: "10px", padding: "10px 12px", fontSize: "12px", color: P.gray, lineHeight: "1.8" }}>
              {hasPublic && <div>✈️🚄🚂🚌🚍 대중교통 → 수단별 <b style={{ color: P.dark }}>전용 집합장소 + 도착 허브</b> 기준으로 계산</div>}
              {hasPrivate && <div>🚗🚲🚶 개인 이동 → 위치 기반 <b style={{ color: P.dark }}>목적지</b> 바로 결정</div>}
            </div>
          )}
        </Card>

        {/* 여행 기간 */}
        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontWeight: "700", color: P.dark, marginBottom: "10px", fontSize: "14px" }}>여행 기간</div>
          <div style={{ display: "flex", gap: "8px" }}>
            {["당일치기", "1박 2일", "2박 3일"].map(d => <Chip key={d} label={d} active={settings.duration === d} onClick={() => setSettings(s => ({ ...s, duration: d }))} />)}
          </div>
        </Card>

        {/* 출발 시간 */}
        <Card style={{ marginBottom: "16px" }}>
          <div style={{ fontWeight: "700", color: P.dark, marginBottom: "10px", fontSize: "14px" }}>출발 가능 시간</div>
          <input type="time" value={settings.time} onChange={e => setSettings(s => ({ ...s, time: e.target.value }))}
            style={{ width: "100%", border: `2px solid ${P.border}`, borderRadius: "10px", padding: "10px 14px", fontSize: "16px", outline: "none", boxSizing: "border-box", background: P.lightGray, color: P.dark, fontWeight: "600" }} />
        </Card>

        <Btn disabled={settings.transports.length === 0} onClick={generatePlan}>🎲 위치 기반 여행 계획 생성!</Btn>
        <Btn variant="secondary" style={{ marginTop: "8px" }} onClick={() => setStep("input")}>← 참가자 수정</Btn>
      </div>
    );
  }

  // ── PLANNING ──
  if (step === "planning") return wrap(
    <div style={{ paddingTop: "80px", textAlign: "center" }}>
      <div style={{ fontSize: "64px", marginBottom: "16px", animation: "float 2s ease-in-out infinite", display: "inline-block" }}>✈️</div>
      <style>{`@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}`}</style>
      <h2 style={{ fontSize: "22px", fontWeight: "800", color: P.dark, marginBottom: "8px" }}>여행 계획 생성 중...</h2>
      <p style={{ color: P.gray, fontSize: "14px", minHeight: "22px" }}>{planMsg}</p>
      <LoadingDots />
    </div>
  );

  // ── PLAN RESULT ──
  if (step === "plan_result" && plan) {
    const isPublic = plan.transport.type === "public";
    const destTags = plan.destination.tags || [];
    const scheduleQuery = [
      plan.transport.label,
      plan.hub?.name,
      plan.arrivalHub?.name,
      plan.destination.name,
      "시간표",
    ].filter(Boolean).join(" ");
    const scheduleUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(scheduleQuery)}`;
    return wrap(
      <div style={{ paddingTop: "20px" }}>
        <div style={{ textAlign: "center", marginBottom: "20px" }}>
          <div style={{ fontSize: "48px" }}>{plan.transport.emoji}</div>
          <h2 style={{ fontSize: "26px", fontWeight: "900", color: P.dark, margin: "6px 0 4px" }}>여행 계획 완성! 🎉</h2>
          <p style={{ color: P.gray, fontSize: "13px" }}>참가자 위치 기반으로 최적 계획을 세웠어요</p>
        </div>

        {/* 이동수단 */}
        <Card style={{ marginBottom: "12px", border: `2px solid ${P.purpleMid}`, textAlign: "center" }}>
          <div style={{ fontSize: "11px", color: P.gray, fontWeight: "600", marginBottom: "6px" }}>🎲 랜덤으로 뽑힌 여행 수단</div>
          <div style={{ fontSize: "36px" }}>{plan.transport.emoji}</div>
          <div style={{ fontSize: "24px", fontWeight: "900", color: P.purple, margin: "4px 0" }}>{plan.transport.label}</div>
        </Card>

        {/* 집합장소 (대중교통) */}
        {isPublic && plan.hub && (
          <Card style={{ marginBottom: "12px", background: "#f0f8ff" }}>
            <div style={{ fontSize: "11px", color: "#45aaf2", fontWeight: "700", marginBottom: "6px" }}>📍 최적 집합장소</div>
            <div style={{ fontSize: "22px", fontWeight: "800", color: P.dark, marginBottom: "4px" }}>{plan.hub.name}</div>
            <div style={{ fontSize: "13px", color: P.gray, marginBottom: "10px" }}>
              모든 참가자의 위치를 고려한 최적 교통 거점
            </div>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <div><div style={{ fontSize: "11px", color: P.gray }}>출발</div><div style={{ fontWeight: "700", color: P.dark }}>{plan.departTime}</div></div>
              <div><div style={{ fontSize: "11px", color: P.gray }}>예상 소요</div><div style={{ fontWeight: "700", color: P.dark }}>{plan.estimatedTime}</div></div>
              <div><div style={{ fontSize: "11px", color: P.gray }}>총 이동</div><div style={{ fontWeight: "700", color: P.dark }}>{formatDistance(plan.distFromHub)}</div></div>
            </div>
          </Card>
        )}

        {/* 도착 허브 (대중교통) */}
        {isPublic && plan.arrivalHub && (
          <Card style={{ marginBottom: "12px", background: "#f5fff8" }}>
            <div style={{ fontSize: "11px", color: "#26de81", fontWeight: "700", marginBottom: "6px" }}>🚏 도착 허브</div>
            <div style={{ fontSize: "20px", fontWeight: "800", color: P.dark, marginBottom: "4px" }}>{plan.arrivalHub.name}</div>
            <div style={{ fontSize: "13px", color: P.gray }}>
              선택된 교통수단으로 접근 가능한 목적지 인접 허브
            </div>
          </Card>
        )}

        {/* 목적지 */}
        <Card style={{ marginBottom: "12px", background: "#f0fff6" }}>
          <div style={{ fontSize: "11px", color: "#26de81", fontWeight: "700", marginBottom: "6px" }}>🎯 랜덤 목적지</div>
          <div style={{ fontSize: "22px", fontWeight: "800", color: P.dark, marginBottom: "4px" }}>{plan.destination.name}</div>
          <div style={{ fontSize: "13px", color: P.gray, marginBottom: "8px" }}>{plan.destination.description}</div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
            {destTags.map((tag, i) => <Tag key={i} color="#26de81">{tag}</Tag>)}
          </div>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            {!isPublic && (
              <>
                <div><div style={{ fontSize: "11px", color: P.gray }}>출발지에서</div><div style={{ fontWeight: "700", color: P.dark }}>{formatDistance(plan.distFromCentroid)}</div></div>
                <div><div style={{ fontSize: "11px", color: P.gray }}>예상 소요</div><div style={{ fontWeight: "700", color: P.dark }}>{plan.estimatedTime}</div></div>
              </>
            )}
            <div><div style={{ fontSize: "11px", color: P.gray }}>지역</div><div style={{ fontWeight: "700", color: P.dark }}>{plan.destination.region}</div></div>
          </div>
        </Card>

        {/* 지도 링크 */}
        <Card style={{ marginBottom: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            {plan.hub && (
              <a href={`https://map.kakao.com/link/search/${encodeURIComponent(plan.hub.name)}`} target="_blank" rel="noopener noreferrer"
                style={{ display: "block", background: "#FEE500", color: "#3A1D1D", border: "none", borderRadius: "14px", padding: "13px", fontSize: "13px", fontWeight: "700", textAlign: "center", textDecoration: "none" }}>
                🗺️ 집합장소 지도
              </a>
            )}
            {plan.arrivalHub && (
              <a href={`https://map.kakao.com/link/search/${encodeURIComponent(plan.arrivalHub.name)}`} target="_blank" rel="noopener noreferrer"
                style={{ display: "block", background: "#FEE500", color: "#3A1D1D", border: "none", borderRadius: "14px", padding: "13px", fontSize: "13px", fontWeight: "700", textAlign: "center", textDecoration: "none" }}>
                🚏 도착허브 지도
              </a>
            )}
            <a href={`https://map.kakao.com/link/search/${encodeURIComponent(plan.destination.name)}`} target="_blank" rel="noopener noreferrer"
              style={{ display: "block", background: "#FEE500", color: "#3A1D1D", border: "none", borderRadius: "14px", padding: "13px", fontSize: "13px", fontWeight: "700", textAlign: "center", textDecoration: "none", gridColumn: plan.hub || plan.arrivalHub ? "auto" : "1 / -1" }}>
              🗺️ 목적지 지도
            </a>
            <a href={scheduleUrl} target="_blank" rel="noopener noreferrer"
              style={{ display: "block", background: "#ecfeff", color: "#0f766e", border: "2px solid #99f6e4", borderRadius: "14px", padding: "13px", fontSize: "13px", fontWeight: "700", textAlign: "center", textDecoration: "none", gridColumn: "1 / -1" }}>
              🕒 시간표 검색
            </a>
          </div>
        </Card>

        {/* 저장/공유 */}
        <Card style={{ marginBottom: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <Btn variant="outline" onClick={saveCurrentPlan}>💾 계획 저장</Btn>
            <Btn variant="outline" onClick={shareCurrentPlan}>📤 계획 공유</Btn>
          </div>
          {shareMsg && (
            <div style={{ fontSize: "12px", color: P.gray, marginTop: "10px", textAlign: "center" }}>{shareMsg}</div>
          )}
        </Card>

        {/* 저장된 계획 */}
        {savedPlans.length > 0 && (
          <Card style={{ marginBottom: "12px" }}>
            <div style={{ fontWeight: "700", fontSize: "13px", color: P.gray, marginBottom: "10px" }}>🗂️ 저장된 여행 계획</div>
            {savedPlans.slice(0, 3).map(item => (
              <div key={item.id} style={{ padding: "8px 0", borderBottom: `1px solid ${P.border}` }}>
                <div style={{ fontSize: "14px", color: P.dark, fontWeight: "700" }}>
                  {item.transportEmoji} {item.destinationName}
                </div>
                <div style={{ fontSize: "12px", color: P.gray }}>
                  {item.destinationRegion} · {item.estimatedTime} · {item.createdAt}
                </div>
              </div>
            ))}
          </Card>
        )}

        {/* 꿀팁 */}
        <Card style={{ marginBottom: "20px", background: "#fff9f0" }}>
          <div style={{ fontSize: "13px", color: "#ff9f43" }}><b>💡 꿀팁</b> {plan.tip}</div>
        </Card>

        <Btn onClick={() => { setStep("travel"); getGPS(); }}>🗺️ 여행지 도착! 랜덤 모드 시작</Btn>
        <Btn variant="secondary" style={{ marginTop: "8px" }} onClick={generatePlan}>↺ 다시 뽑기</Btn>
        <Btn variant="ghost" style={{ marginTop: "4px" }} onClick={() => setStep("settings")}>← 설정으로</Btn>
      </div>
    );
  }

  // ── TRAVEL (여행 모드 — GPS 기반) ──
  if (step === "travel") return wrap(
    <div style={{ paddingTop: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div>
          <h2 style={{ fontSize: "22px", fontWeight: "900", color: P.dark, margin: 0 }}>
            {plan?.destination ? `📍 ${plan.destination.name}` : "📍 여행 중"}
          </h2>
          <div style={{ fontSize: "12px", color: activeTravelCoords ? "#26de81" : P.gray, marginTop: "3px" }}>
            {travelLocationMode === "manual"
              ? (activeTravelCoords ? `✅ 직접 선택 (${activeTravelCoords.lat.toFixed(4)}, ${activeTravelCoords.lng.toFixed(4)})` : "⚠️ 직접 선택 위치를 지정해 주세요")
              : (gps ? `✅ GPS (${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)})` : gpsErr ? "⚠️ GPS 사용 불가" : "⏳ GPS 불러오는 중...")}
          </div>
          {travelLocationMode === "gps" && gps && gpsAccuracyM !== null && (
            <div style={{ fontSize: "12px", color: P.gray, marginTop: "3px" }}>
              정확도: ±{gpsAccuracyM}m
            </div>
          )}
          {travelLocationMode === "gps" && !gps && gpsErrMsg && (
            <div style={{ fontSize: "12px", color: "#ef4444", marginTop: "3px" }}>
              {gpsErrMsg}
            </div>
          )}
          {activeTravelCoords && currentAddr && (
            <div style={{ fontSize: "12px", color: P.gray, marginTop: "3px" }}>📌 {currentAddr}</div>
          )}
        </div>
        <button
          onClick={() => travelLocationMode === "gps" && getGPS()}
          style={{ background: P.purpleLight, border: "none", borderRadius: "10px", padding: "8px 12px", color: P.purple, fontWeight: "700", fontSize: "12px", cursor: travelLocationMode === "gps" ? "pointer" : "not-allowed", opacity: travelLocationMode === "gps" ? 1 : 0.5 }}
        >
          GPS 갱신
        </button>
      </div>

      <Card style={{ marginBottom: "12px", padding: "14px 16px" }}>
        <div style={{ fontWeight: "700", color: P.dark, fontSize: "13px", marginBottom: "8px" }}>📌 위치 입력 방식</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
          <button
            onClick={() => setTravelLocationMode("gps")}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: "12px",
              border: `2px solid ${travelLocationMode === "gps" ? P.purple : P.border}`,
              background: travelLocationMode === "gps" ? P.purpleLight : P.white,
              color: travelLocationMode === "gps" ? P.purple : P.gray,
              fontWeight: "700",
              cursor: "pointer",
            }}
          >
            GPS 사용
          </button>
          <button
            onClick={() => setTravelLocationMode("manual")}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: "12px",
              border: `2px solid ${travelLocationMode === "manual" ? P.purple : P.border}`,
              background: travelLocationMode === "manual" ? P.purpleLight : P.white,
              color: travelLocationMode === "manual" ? P.purple : P.gray,
              fontWeight: "700",
              cursor: "pointer",
            }}
          >
            직접 선택
          </button>
        </div>

        {travelLocationMode === "manual" && (
          <div style={{ display: "grid", gap: "8px" }}>
            <div style={{ fontSize: "12px", color: P.gray }}>
              지도를 눌러 기준 위치를 찍어 주세요.
            </div>
            <MapPicker
              center={manualPoint ?? gps ?? { lat: 37.5665, lng: 126.978 }}
              selected={manualPoint}
              onPick={setManualPoint}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "12px", color: P.gray }}>
                {manualPoint
                  ? `선택 좌표: ${manualPoint.lat.toFixed(5)}, ${manualPoint.lng.toFixed(5)}`
                  : "아직 핀을 선택하지 않았습니다."}
              </div>
              <button
                onClick={() => setManualPoint(null)}
                style={{
                  background: "transparent",
                  border: `1px solid ${P.border}`,
                  borderRadius: "10px",
                  padding: "6px 10px",
                  fontSize: "12px",
                  color: P.gray,
                  cursor: "pointer",
                }}
              >
                핀 초기화
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* 전체 랜덤 */}
      <button onClick={() => { const keys = Object.keys(CATEGORY_META); startSpin(keys[Math.floor(Math.random() * keys.length)]); }}
        disabled={travelLocationMode === "manual" && !isManualReady}
        style={{ width: "100%", marginBottom: "12px", padding: "18px", background: `linear-gradient(135deg,${P.purple},${P.pink})`, border: "none", borderRadius: "18px", cursor: travelLocationMode === "manual" && !isManualReady ? "not-allowed" : "pointer", opacity: travelLocationMode === "manual" && !isManualReady ? 0.55 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", boxShadow: `0 4px 20px ${P.purple}40` }}>
        <span style={{ fontSize: "28px" }}>🎲</span>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: "16px", fontWeight: "800", color: "white" }}>뭐든 랜덤으로!</div>
          <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.8)" }}>
            {activeTravelCoords ? "선택한 위치 기준 실제 주변 장소 검색 후 랜덤" : "위치를 먼저 지정해 주세요"}
          </div>
        </div>
      </button>

      {/* 카테고리 선택 */}
      <div style={{ fontWeight: "700", color: P.gray, fontSize: "12px", marginBottom: "8px" }}>카테고리를 고르면 내부에서 반경 설정 후 랜덤</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "20px" }}>
        {Object.entries(CATEGORY_META).map(([key, meta]) => (
          <button key={key} onClick={() => setSelectedConfigCat(key)} disabled={travelLocationMode === "manual" && !isManualReady} style={{ background: meta.bg, border: `2px solid ${selectedConfigCat === key ? meta.color : `${meta.color}20`}`, borderRadius: "16px", padding: "16px 12px", cursor: travelLocationMode === "manual" && !isManualReady ? "not-allowed" : "pointer", opacity: travelLocationMode === "manual" && !isManualReady ? 0.55 : 1, textAlign: "center" }}>
            <div style={{ fontSize: "28px" }}>{meta.emoji}</div>
            <div style={{ fontSize: "13px", fontWeight: "700", color: meta.color, marginTop: "4px" }}>{meta.label}</div>
            <div style={{ fontSize: "11px", color: P.gray, marginTop: "2px" }}>반경 {categoryRadii[key]?.toFixed(1) ?? CATEGORY_META[key].radius}km</div>
          </button>
        ))}
      </div>

      {selectedConfigCat && (
        <Card style={{ marginBottom: "16px", padding: "14px 16px" }}>
          <div style={{ fontWeight: "800", color: P.dark, fontSize: "14px", marginBottom: "10px" }}>
            {CATEGORY_META[selectedConfigCat].emoji} {CATEGORY_META[selectedConfigCat].label} 설정
          </div>

          {CATEGORY_THEMES[selectedConfigCat] && CATEGORY_THEMES[selectedConfigCat].length > 0 && (
            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontWeight: "700", color: P.gray, fontSize: "12px", marginBottom: "8px" }}>
                세부 테마
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {CATEGORY_THEMES[selectedConfigCat].map((theme) => {
                  const active = (categoryThemeKeys[selectedConfigCat] ?? "all") === theme.key;
                  return (
                    <button
                      key={theme.key}
                      onClick={() => setCategoryThemeKeys((prev) => ({ ...prev, [selectedConfigCat]: theme.key }))}
                      style={{
                        padding: "6px 10px",
                        borderRadius: "14px",
                        border: `2px solid ${active ? CATEGORY_META[selectedConfigCat].color : P.border}`,
                        background: active ? CATEGORY_META[selectedConfigCat].bg : P.white,
                        color: active ? CATEGORY_META[selectedConfigCat].color : P.gray,
                        fontSize: "12px",
                        fontWeight: active ? "700" : "600",
                        cursor: "pointer",
                      }}
                    >
                      {theme.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ marginBottom: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <div style={{ fontWeight: "700", color: P.gray, fontSize: "12px" }}>검색 반경</div>
              <div style={{ fontSize: "12px", color: P.purple, fontWeight: "700" }}>
                {(categoryRadii[selectedConfigCat] ?? CATEGORY_META[selectedConfigCat].radius).toFixed(1)}km
              </div>
            </div>
            <input
              type="range"
              min={0.5}
              max={getRadiusMaxKm(selectedConfigCat)}
              step={0.5}
              value={categoryRadii[selectedConfigCat] ?? CATEGORY_META[selectedConfigCat].radius}
              onChange={(e) => setCategoryRadii((prev) => ({ ...prev, [selectedConfigCat]: Number(e.target.value) }))}
              style={{ width: "100%" }}
            />
            <div style={{ fontSize: "11px", color: P.gray, marginTop: "4px" }}>
              최대 {getRadiusMaxKm(selectedConfigCat)}km
            </div>
          </div>

          <Btn onClick={() => startSpin(selectedConfigCat)}>🎯 이 조건으로 랜덤 시작</Btn>
        </Card>
      )}

      {/* 히스토리 */}
      {history.length > 0 && (
        <>
          <div style={{ fontWeight: "700", color: P.gray, fontSize: "12px", marginBottom: "10px" }}>오늘의 여행 기록</div>
          {history.map((h, i) => {
            const m = CATEGORY_META[h.cat];
            return (
              <Card key={i} style={{ padding: "12px 16px", marginBottom: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "22px" }}>{m?.emoji}</span>
                    <div>
                      <div style={{ fontWeight: "700", fontSize: "14px", color: P.dark }}>{h.name}</div>
                      <div style={{ fontSize: "12px", color: P.gray }}>{h.distance} · ⭐{h.rating}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: "12px", color: P.gray }}>{h.time}</div>
                </div>
              </Card>
            );
          })}
        </>
      )}
      <Btn variant="secondary" style={{ marginTop: "12px" }} onClick={() => setStep("home")}>🏠 처음으로</Btn>
    </div>
  );

  // ── SPINNING ──
  if (step === "spinning") {
    const meta = CATEGORY_META[spinCat!] || CATEGORY_META.food;
    const spinRadiusKm = spinCat ? (categoryRadii[spinCat] ?? meta.radius) : meta.radius;
    return wrap(
      <div style={{ paddingTop: "60px", textAlign: "center" }}>
        <div style={{ fontSize: "48px", marginBottom: "8px" }}>{meta.emoji}</div>
        <h2 style={{ fontSize: "22px", fontWeight: "800", color: P.dark, marginBottom: "4px" }}>{meta.label} 랜덤 선택 중...</h2>
        <p style={{ color: P.gray, fontSize: "13px", marginBottom: "20px" }}>
          {gps ? `현재 위치 반경 ${spinRadiusKm < 1 ? `${spinRadiusKm * 1000}m` : `${spinRadiusKm}km`} 탐색 중` : `반경 ${spinRadiusKm}km 이내 후보 선별 중`}
        </p>
        {spinItems.length > 0
          ? <Roulette items={spinItems} finalIdx={spinFinalIdx} spinning={isSpinning} onDone={onSpinDone} />
          : <LoadingDots />}
      </div>
    );
  }

  // ── SPIN RESULT ──
  if (step === "spin_result" && spinResult) {
    const meta = CATEGORY_META[spinCat!] || CATEGORY_META.food;
    const pickedCandidate = spinResult.candidates[spinResult.pickedIdx];
    const topDistancePreview = spinResult.candidates
      .map((c) => {
        const distKm = c.distanceKm ?? (
          activeTravelCoords && c.lat !== undefined && c.lng !== undefined
            ? haversine(activeTravelCoords.lat, activeTravelCoords.lng, c.lat, c.lng)
            : Number.POSITIVE_INFINITY
        );
        return { ...c, distKm };
      })
      .filter((c) => Number.isFinite(c.distKm))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 5);
    const mapViewUrl = pickedCandidate?.lat !== undefined && pickedCandidate?.lng !== undefined
      ? `https://map.kakao.com/link/map/${encodeURIComponent(spinResult.pickedName)},${pickedCandidate.lat},${pickedCandidate.lng}`
      : `https://map.kakao.com/link/search/${encodeURIComponent(spinResult.pickedName)}`;
    const placeDetailUrl = pickedCandidate?.placeUrl ?? mapViewUrl;

    return wrap(
      <div style={{ paddingTop: "20px" }}>
        <div style={{ textAlign: "center", marginBottom: "20px" }}>
          <div style={{ fontSize: "48px" }}>{meta.emoji}</div>
          <div style={{ display: "inline-block", background: meta.bg, color: meta.color, fontWeight: "700", fontSize: "13px", padding: "4px 14px", borderRadius: "20px", marginTop: "6px" }}>{meta.label} 랜덤 결과</div>
        </div>

        <Card style={{ marginBottom: "12px", border: `2px solid ${meta.color}40` }}>
          <div style={{ fontSize: "22px", fontWeight: "900", color: P.dark, marginBottom: "4px" }}>{spinResult.pickedName}</div>
          {spinResult.subLabel && (
            <div style={{ fontSize: "13px", color: meta.color, fontWeight: "700", marginBottom: "6px" }}>{spinResult.subLabel}</div>
          )}
          <div style={{ fontSize: "14px", color: P.gray, marginBottom: "12px" }}>{spinResult.pickedDesc}</div>
          {spinResult.source === "real" && spinResult.candidates[spinResult.pickedIdx]?.address && (
            <div style={{ fontSize: "12px", color: P.gray, marginBottom: "10px" }}>
              주소: {spinResult.candidates[spinResult.pickedIdx]?.address}
            </div>
          )}
          <div style={{ display: "flex", gap: "16px" }}>
            <div><div style={{ fontSize: "11px", color: P.gray }}>거리</div><div style={{ fontWeight: "700", color: P.dark }}>{spinResult.distance}</div></div>
            <div><div style={{ fontSize: "11px", color: P.gray }}>방향</div><div style={{ fontWeight: "700", color: P.dark }}>{spinResult.direction === "-" ? "-" : `🧭 ${spinResult.direction}쪽`}</div></div>
            <div><div style={{ fontSize: "11px", color: P.gray }}>평점</div><div style={{ fontWeight: "700", color: P.dark }}>⭐{spinResult.rating}</div></div>
          </div>
        </Card>

        {!spinResult.noMatch && (
          <Card style={{ marginBottom: "16px" }}>
            {topDistancePreview.length > 0 && (
              <div style={{ marginBottom: "12px", borderBottom: `1px solid ${P.border}`, paddingBottom: "10px" }}>
                <div style={{ fontWeight: "700", fontSize: "13px", color: P.gray, marginBottom: "6px" }}>📍 실제 거리순 상위 {topDistancePreview.length}개</div>
                {topDistancePreview.map((c, i) => (
                  <div key={`${c.name}-${i}`} style={{ fontSize: "13px", color: P.dark, marginBottom: "4px" }}>
                    {i + 1}. {c.name} · {formatDistance(c.distKm)}
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontWeight: "700", fontSize: "13px", color: P.gray, marginBottom: "10px" }}>📋 이번 후보 목록</div>
            {spinResult.candidates.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderBottom: i < spinResult.candidates.length - 1 ? `1px solid ${P.border}` : "none" }}>
                <span>{i === spinResult.pickedIdx ? "✅" : "⬜"}</span>
                <span style={{ fontSize: "14px", color: i === spinResult.pickedIdx ? P.dark : P.gray, fontWeight: i === spinResult.pickedIdx ? "700" : "400" }}>
                  {c.name}{c.address ? ` · ${c.address}` : ""}
                </span>
              </div>
            ))}
          </Card>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
          {spinResult.noMatch ? (
            <Btn variant="secondary" onClick={() => setStep("travel")}>🔧 조건 다시 설정</Btn>
          ) : (
            <>
              <a href={placeDetailUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "block", background: "#FEE500", color: "#3A1D1D", border: "none", borderRadius: "14px", padding: "13px", fontSize: "14px", fontWeight: "700", textAlign: "center", textDecoration: "none" }}>
                🔎 카카오맵 상세 보기
              </a>
              <a href={mapViewUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "block", background: "#fff7cc", color: "#3A1D1D", border: "1px solid #FEE500", borderRadius: "14px", padding: "13px", fontSize: "14px", fontWeight: "700", textAlign: "center", textDecoration: "none" }}>
                🗺️ 카카오맵에서 위치 보기
              </a>
            </>
          )}
          <Btn variant="outline" onClick={() => startSpin(spinCat!)} style={spinResult.noMatch ? {} : { gridColumn: "1 / -1" }}>🔄 다시 뽑기</Btn>
        </div>
        <Btn onClick={() => setStep("travel")}>← 여행 모드로 돌아가기</Btn>
      </div>
    );
  }

  return null;
}
