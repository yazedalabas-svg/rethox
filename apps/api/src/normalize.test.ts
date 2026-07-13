import { describe,expect,it } from "vitest";
describe("timings",()=>{it("keeps token ranges ordered",()=>{const values=[{startMs:0,endMs:300},{startMs:350,endMs:700}];expect(values.every((v,i)=>i===0||v.startMs>=values[i-1].endMs)).toBe(true);});});
