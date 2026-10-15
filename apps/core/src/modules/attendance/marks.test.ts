import { metresBetween, placeOf } from "./marks";

/**
 * THE OWNER'S DONE-MEANS (decision 0061): inside 200 m saves "inside", 201 m saves "outside". The
 * points are walked due north from the centre along the meridian, where the haversine distance is
 * exactly the arc, so "201 m" here is 201 m by the same arithmetic the server uses.
 */
const SITE = { lat: 25.6892879, lng: 85.2301486, radiusM: 200 };
const EARTH_M = 6_371_008.8;
const north = (m: number) => ({ latitude: SITE.lat + (m / EARTH_M) * (180 / Math.PI), longitude: SITE.lng, mocked: false });

describe("placeOf — the one judgement of an app mark", () => {
  it("measures a walked-north point back to the metre", () => {
    expect(metresBetween(SITE, { lat: north(200).latitude, lng: SITE.lng })).toBeCloseTo(200, 6);
  });

  it("200 m is inside, 201 m is outside, and the metres are kept whole", () => {
    expect(placeOf(north(0), SITE)).toEqual({ place: "inside", distanceM: 0 });
    expect(placeOf(north(200), SITE)).toEqual({ place: "inside", distanceM: 200 });
    expect(placeOf(north(200.4), SITE)).toEqual({ place: "inside", distanceM: 200 });
    expect(placeOf(north(201), SITE)).toEqual({ place: "outside", distanceM: 201 });
    expect(placeOf(north(5000), SITE)).toEqual({ place: "outside", distanceM: 5000 });
  });

  it("east-west counts the same as north-south", () => {
    const east = { latitude: SITE.lat, longitude: SITE.lng + 0.0025, mocked: false }; // ≈ 251 m at this latitude
    expect(placeOf(east, SITE).place).toBe("outside");
    expect(placeOf(east, { ...SITE, radiusM: 300 }).place).toBe("inside");
  });

  it("no reading is 'not shared'; a mocked reading is 'doubtful' even at the centre", () => {
    expect(placeOf(null, SITE)).toEqual({ place: "not_shared", distanceM: null });
    expect(placeOf({ ...north(0), mocked: true }, SITE)).toEqual({ place: "doubtful", distanceM: 0 });
  });

  it("the radius is the setting's, not a constant", () => {
    expect(placeOf(north(250), { ...SITE, radiusM: 300 }).place).toBe("inside");
    expect(placeOf(north(250), SITE).place).toBe("outside");
  });
});
