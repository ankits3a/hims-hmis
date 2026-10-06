import { configure } from "@testing-library/react-native";

/*
  CI's runner is several times slower than the build box on a suite's FIRST render (cold module
  graph): `findBy…` gave up at the library's 1 s default while the screen was still mounting, and
  the mobile job went red on a test that passes everywhere else (PR #499, 2026-10-06). The wait is a
  ceiling, not a delay — a found element returns at once — so a generous one costs nothing.
*/
configure({ asyncUtilTimeout: 15_000 });
jest.setTimeout(60_000);
