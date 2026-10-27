// The whole run, for anything that reads JSON. The same shape that is kept in cortad/runs.
export const asJson = (result) => JSON.stringify({
  judge: result.run.judge,
  suite: result.run.suite,
  plays: result.run.plays,
  held: result.counted.held,
  broke: result.counted.broke,
  unsettled: result.counted.unknown,
  absent: result.counted.absent,
  rate: result.rate,
  moved: result.moved,
  conversations: result.run.conversations,
}, null, 2);
