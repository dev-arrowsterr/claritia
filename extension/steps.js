// Claritia Recorder: how recorded steps are kept. Shared by the background worker and the record-then-replay check.

/** A new step, merged with the last one when it's the same field typed again. */
export function addStep(steps, step) {
  const last = steps[steps.length - 1];
  if (step.key && last?.key === step.key) return [...steps.slice(0, -1), step];
  return [...steps, step];
}
