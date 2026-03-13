// Haversine formula: 두 좌표 간 거리 (km)
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

// 여러 참가자의 중심점 (centroid) 계산
export function centroid(points: { lat: number; lng: number }[]): { lat: number; lng: number } {
  if (points.length === 0) return { lat: 37.5665, lng: 126.978 };
  if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng };
  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

// 이동수단별 합리적 최대 반경 (km)
export const TRANSPORT_RADIUS: Record<string, number> = {
  plane: 600,
  boat: 400,
  ktx: 420,
  rail: 280,
  expressBus: 300,
  intercityBus: 220,
  train: 350,
  bus: 250,
  car: 200,
  bicycle: 30,
  walk: 5,
};

// 이동수단별 합리적 최소 거리 (km) - 너무 가까우면 해당 수단이 의미없음
export const TRANSPORT_MIN: Record<string, number> = {
  plane: 150,
  boat: 30,
  ktx: 80,
  rail: 40,
  expressBus: 60,
  intercityBus: 30,
  train: 50,
  bus: 30,
  car: 20,
  bicycle: 3,
  walk: 0.5,
};

// 주어진 좌표 근처에서 가장 가까운 항목 찾기
export function findNearest<T extends { lat: number; lng: number }>(
  origin: { lat: number; lng: number },
  items: T[],
  maxKm?: number
): T[] {
  const withDist = items.map((item) => ({
    ...item,
    _dist: haversine(origin.lat, origin.lng, item.lat, item.lng),
  }));
  const filtered = maxKm ? withDist.filter((x) => x._dist <= maxKm) : withDist;
  return filtered.sort((a, b) => a._dist - b._dist);
}

// 이동수단에 따른 합리적 목적지 필터링
export function filterByTransport(
  origin: { lat: number; lng: number },
  items: { lat: number; lng: number }[],
  transportKey: string
): typeof items {
  const max = TRANSPORT_RADIUS[transportKey] || 200;
  const min = TRANSPORT_MIN[transportKey] || 0;
  return items.filter((item) => {
    const d = haversine(origin.lat, origin.lng, item.lat, item.lng);
    return d >= min && d <= max;
  });
}

// 대중교통 주요 허브와의 거리 기준 최적 집합장소 찾기
export interface TransportHub {
  name: string;
  lat: number;
  lng: number;
  types: string[]; // ["train","bus"] 등
}

const KTX_CORE_HUBS = new Set([
  "서울역",
  "용산역",
  "대전역",
  "동대구역",
  "부산역",
  "광주송정역",
  "울산역(KTX)",
  "천안아산역",
]);

function isBusTerminalName(name: string): boolean {
  return name.includes("터미널");
}

function isExpressBusHub(name: string): boolean {
  return name.includes("고속버스터미널") || name.includes("종합버스터미널");
}

function isIntercityBusHub(name: string): boolean {
  return name.includes("시외버스터미널") || name.includes("터미널");
}

export function hubMatchesTransport(hub: TransportHub, transportKey: string): boolean {
  const hasType = (t: string) => hub.types.includes(t);

  switch (transportKey) {
    case "plane":
      return hasType("plane");
    case "boat":
      return hasType("boat");
    case "ktx":
      return hasType("train") && (KTX_CORE_HUBS.has(hub.name) || hub.name.includes("KTX"));
    case "rail":
      return hasType("train");
    case "expressBus":
      return hasType("bus") && isExpressBusHub(hub.name);
    case "intercityBus":
      return hasType("bus") && isIntercityBusHub(hub.name);
    case "train":
      return hasType("train");
    case "bus":
      return hasType("bus") && isBusTerminalName(hub.name);
    default:
      return false;
  }
}

export const TRANSPORT_HUBS: TransportHub[] = [
  // 서울
  { name: "서울역", lat: 37.5547, lng: 126.9707, types: ["train", "bus"] },
  { name: "용산역", lat: 37.5299, lng: 126.9646, types: ["train"] },
  { name: "강남역", lat: 37.4979, lng: 127.0276, types: ["bus"] },
  { name: "서울고속버스터미널", lat: 37.5049, lng: 127.0049, types: ["bus"] },
  { name: "동서울종합터미널", lat: 37.5345, lng: 127.0937, types: ["bus"] },
  { name: "잠실역", lat: 37.5133, lng: 127.1001, types: ["bus"] },
  { name: "홍대입구역", lat: 37.5571, lng: 126.9244, types: ["bus"] },
  { name: "김포공항", lat: 37.5586, lng: 126.7906, types: ["plane"] },
  // 인천
  { name: "인천공항", lat: 37.4602, lng: 126.4407, types: ["plane"] },
  { name: "인천터미널", lat: 37.4415, lng: 126.7031, types: ["bus"] },
  { name: "인천항", lat: 37.4519, lng: 126.5997, types: ["boat"] },
  // 경기
  { name: "수원역", lat: 37.2660, lng: 127.0016, types: ["train", "bus"] },
  { name: "수원버스터미널", lat: 37.2636, lng: 127.0286, types: ["bus"] },
  { name: "성남(모란)역", lat: 37.4321, lng: 127.1291, types: ["bus"] },
  // 대전
  { name: "대전역", lat: 36.3324, lng: 127.4346, types: ["train", "bus"] },
  { name: "대전복합터미널", lat: 36.3519, lng: 127.4371, types: ["bus"] },
  // 대구
  { name: "동대구역", lat: 35.8792, lng: 128.6286, types: ["train", "bus"] },
  { name: "대구공항", lat: 35.8941, lng: 128.6555, types: ["plane"] },
  // 부산
  { name: "부산역", lat: 35.1152, lng: 129.0404, types: ["train"] },
  { name: "부산종합버스터미널", lat: 35.1768, lng: 129.0761, types: ["bus"] },
  { name: "김해공항", lat: 35.1795, lng: 128.9382, types: ["plane"] },
  { name: "부산항", lat: 35.0967, lng: 129.0367, types: ["boat"] },
  // 광주
  { name: "광주송정역", lat: 35.1381, lng: 126.7913, types: ["train"] },
  { name: "광주종합버스터미널", lat: 35.1604, lng: 126.8798, types: ["bus"] },
  { name: "광주공항", lat: 35.1264, lng: 126.8089, types: ["plane"] },
  // 울산
  { name: "울산역(KTX)", lat: 35.5499, lng: 129.1103, types: ["train"] },
  { name: "울산시외버스터미널", lat: 35.5384, lng: 129.3114, types: ["bus"] },
  // 강원
  { name: "강릉역", lat: 37.7642, lng: 128.8961, types: ["train"] },
  { name: "춘천역", lat: 37.8847, lng: 127.7175, types: ["train"] },
  { name: "원주역", lat: 37.3267, lng: 127.9204, types: ["train"] },
  { name: "속초시외버스터미널", lat: 38.2070, lng: 128.5918, types: ["bus"] },
  // 충북
  { name: "청주공항", lat: 36.7166, lng: 127.4993, types: ["plane"] },
  { name: "청주시외버스터미널", lat: 36.6357, lng: 127.4917, types: ["bus"] },
  // 충남
  { name: "천안아산역", lat: 36.7948, lng: 127.1045, types: ["train"] },
  { name: "천안터미널", lat: 36.8123, lng: 127.1137, types: ["bus"] },
  // 전북
  { name: "전주역", lat: 35.8122, lng: 127.1481, types: ["train"] },
  { name: "전주시외버스터미널", lat: 35.8244, lng: 127.1447, types: ["bus"] },
  // 전남
  { name: "목포역", lat: 34.7909, lng: 126.3826, types: ["train"] },
  { name: "여수엑스포역", lat: 34.7478, lng: 127.7407, types: ["train"] },
  { name: "목포항", lat: 34.7802, lng: 126.3789, types: ["boat"] },
  { name: "완도항", lat: 34.3111, lng: 126.7553, types: ["boat"] },
  // 경북
  { name: "포항역", lat: 36.0070, lng: 129.3591, types: ["train"] },
  { name: "경주역", lat: 35.8565, lng: 129.2248, types: ["train"] },
  { name: "안동터미널", lat: 36.5684, lng: 128.7294, types: ["bus"] },
  // 경남
  { name: "진주시외버스터미널", lat: 35.1798, lng: 128.0842, types: ["bus"] },
  { name: "창원역", lat: 35.2280, lng: 128.6815, types: ["train"] },
  { name: "통영터미널", lat: 34.8544, lng: 128.4334, types: ["bus", "boat"] },
  // 제주
  { name: "제주공항", lat: 33.5104, lng: 126.4914, types: ["plane"] },
  { name: "제주항", lat: 33.5228, lng: 126.5280, types: ["boat"] },
  { name: "서귀포시외버스터미널", lat: 33.2520, lng: 126.5098, types: ["bus"] },
];

// 참가자들의 위치 기반 최적 교통 허브 찾기
// 각 참가자에서 허브까지의 거리 합이 최소인 허브를 선택
export function findOptimalHub(
  participants: { lat: number; lng: number }[],
  transportKey: string
): TransportHub | null {
  const publicKeys = ["plane", "boat", "ktx", "rail", "expressBus", "intercityBus", "train", "bus"];
  if (!publicKeys.includes(transportKey)) return null; // 자가용/자전거/걷기는 허브 불필요

  const hubs = TRANSPORT_HUBS.filter((h) => hubMatchesTransport(h, transportKey));
  if (hubs.length === 0) return null;

  let bestHub = hubs[0];
  let bestScore = Infinity;

  for (const hub of hubs) {
    const totalDist = participants.reduce(
      (sum, p) => sum + haversine(p.lat, p.lng, hub.lat, hub.lng),
      0
    );
    if (totalDist < bestScore) {
      bestScore = totalDist;
      bestHub = hub;
    }
  }

  return bestHub;
}

// 거리를 보기 좋게 포맷
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  if (km < 10) return `${km.toFixed(1)}km`;
  return `${Math.round(km)}km`;
}

// 예상 소요시간 계산
export function estimateTime(km: number, transportKey: string): string {
  const speeds: Record<string, number> = {
    plane: 500,
    boat: 30,
    ktx: 210,
    rail: 110,
    subway: 40,
    expressBus: 85,
    intercityBus: 70,
    train: 150,
    bus: 70,
    car: 80,
    bicycle: 15,
    walk: 4,
  };
  const speed = speeds[transportKey] || 60;
  const hours = km / speed;
  if (hours < 1) return `약 ${Math.round(hours * 60)}분`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `약 ${h}시간 ${m}분` : `약 ${h}시간`;
}

// 방위각 계산 (N, NE, E, SE, S, SW, W, NW)
export function bearing(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): string {
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLng);
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  deg = (deg + 360) % 360;
  const dirs = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
  return dirs[Math.round(deg / 45) % 8];
}

export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const pickN = <T>(arr: T[], n: number): T[] =>
  [...arr].sort(() => Math.random() - 0.5).slice(0, n);
