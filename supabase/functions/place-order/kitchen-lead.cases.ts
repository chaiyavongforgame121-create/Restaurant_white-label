// The kitchen-lead case table: settings as JSON text -> minutes before its booked time a booking
// reaches the kitchen. One table for the three readers of the rule, so none can drift:
//   - ./kitchen-lead.test.ts (deno test) runs it against this folder's kitchenLeadMin();
//   - packages/shared/src/utils/kitchen-lead.test.ts (vitest) runs it against both copies, and
//     fails unless supabase/tests/kitchen_lead_is_prep_time.sql carries the same rows, in order;
//   - that SQL file runs the rows against private.branch_kitchen_lead_min, the release job's reader.
// JSON text rather than objects because the database only ever holds JSON: each row is what a
// branch's settings can be, read the same way by JSON.parse and by ::jsonb.
//
// Test data only: index.ts does not import it, so it is not part of the deployed function.

export const KITCHEN_LEAD_CASES: ReadonlyArray<readonly [label: string, settings: string, lead: number]> = [
  // The rule: Prep time plus busy mode, at most a week.
  ['nothing saved: the default prep time', '{}', 15],
  ['prep 20', '{"prep_time_min": 20}', 20],
  ['prep 20 plus busy 10', '{"prep_time_min": 20, "busy_extra_prep_min": 10}', 30],
  ['busy 10 on the default prep time', '{"busy_extra_prep_min": 10}', 25],
  ['prep 0: at the booked time', '{"prep_time_min": 0}', 0],
  ['prep 0 plus busy 0', '{"prep_time_min": 0, "busy_extra_prep_min": 0}', 0],
  ['prep 0 plus busy 10', '{"prep_time_min": 0, "busy_extra_prep_min": 10}', 10],
  ['prep 15.0 is a whole number', '{"prep_time_min": 15.0}', 15],
  ['prep 1e2 is 100', '{"prep_time_min": 1e2}', 100],
  ['prep -0 is 0', '{"prep_time_min": -0}', 0],
  ['prep -0 plus busy -0 is 0', '{"prep_time_min": -0, "busy_extra_prep_min": -0}', 0],
  ['prep 10080, a week', '{"prep_time_min": 10080}', 10080],
  ['prep 10000 plus busy 79', '{"prep_time_min": 10000, "busy_extra_prep_min": 79}', 10079],
  ['prep 10000 plus busy 100: capped at a week', '{"prep_time_min": 10000, "busy_extra_prep_min": 100}', 10080],
  ['prep 10080 plus busy 10: capped at a week', '{"prep_time_min": 10080, "busy_extra_prep_min": 10}', 10080],
  ['busy 10080 on the default prep time: capped at a week', '{"busy_extra_prep_min": 10080}', 10080],

  // "Send to kitchen (minutes before)" is not read any more, whatever it holds.
  ['a saved lead of 5 beside prep 15 is ignored', '{"schedule_lead_time_min": 5, "prep_time_min": 15}', 15],
  ['a saved lead of 0 beside prep 20 is ignored', '{"schedule_lead_time_min": 0, "prep_time_min": 20}', 20],
  ['a saved lead alone is ignored', '{"schedule_lead_time_min": 60}', 15],
  ['a saved lead beside prep 5 plus busy 10 is ignored', '{"schedule_lead_time_min": 45, "prep_time_min": 5, "busy_extra_prep_min": 10}', 15],

  // A prep time that is not a whole number 0-10080 is skipped for the default, never coerced.
  ['prep 7.5', '{"prep_time_min": 7.5}', 15],
  ['prep "15"', '{"prep_time_min": "15"}', 15],
  ['prep "15 "', '{"prep_time_min": "15 "}', 15],
  ['prep -1', '{"prep_time_min": -1}', 15],
  ['prep 10081', '{"prep_time_min": 10081}', 15],
  ['prep 1e400', '{"prep_time_min": 1e400}', 15],
  ['prep "abc"', '{"prep_time_min": "abc"}', 15],
  ['prep ""', '{"prep_time_min": ""}', 15],
  ['prep true', '{"prep_time_min": true}', 15],
  ['prep null', '{"prep_time_min": null}', 15],
  ['prep [5]', '{"prep_time_min": [5]}', 15],
  ['prep {"m": 5}', '{"prep_time_min": {"m": 5}}', 15],
  ['prep 7.5 plus busy 10: the default prep time plus busy', '{"prep_time_min": 7.5, "busy_extra_prep_min": 10}', 25],

  // A busy extra that is not a whole number 0-10080 counts as no extra.
  ['busy 7.5', '{"prep_time_min": 20, "busy_extra_prep_min": 7.5}', 20],
  ['busy "10"', '{"prep_time_min": 20, "busy_extra_prep_min": "10"}', 20],
  ['busy -1', '{"prep_time_min": 20, "busy_extra_prep_min": -1}', 20],
  ['busy 10081', '{"prep_time_min": 20, "busy_extra_prep_min": 10081}', 20],
  ['busy "abc"', '{"prep_time_min": 20, "busy_extra_prep_min": "abc"}', 20],
  ['busy true', '{"prep_time_min": 20, "busy_extra_prep_min": true}', 20],
  ['busy null', '{"prep_time_min": 20, "busy_extra_prep_min": null}', 20],
  ['busy [5]', '{"prep_time_min": 20, "busy_extra_prep_min": [5]}', 20],
  ['busy {"m": 5}', '{"prep_time_min": 20, "busy_extra_prep_min": {"m": 5}}', 20],
  ['both bad: the default', '{"prep_time_min": "abc", "busy_extra_prep_min": -5}', 15],

  // Settings that are not an object read as nothing saved.
  ['JSON null', 'null', 15],
  ['an empty array', '[]', 15],
  ['an array of settings', '[{"prep_time_min": 5}]', 15],
  ['a number', '5', 15],
  ['a string', '"x"', 15],
  ['a boolean', 'true', 15],
];
