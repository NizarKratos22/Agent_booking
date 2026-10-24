import { isEmergency } from './emergency';

describe('emergency detection', () => {
  const positives = [
    'عندي وجيعة قوية ما نجمش نستنى',
    'سني تكسرت و فما دم',
    'الخد منفوخ برشا',
    '3andi wji3a 9wiya barcha',
    'ma najamch nestanna lel ghodwa',
    "j'ai une douleur insupportable",
    "c'est urgent, mon fils est tombé et sa dent est cassée",
    'ça saigne beaucoup',
  ];
  const negatives = [
    'نحب نأخذ rendez-vous غدوة الصباح',
    'قداش التنظيف؟',
    'nheb rdv lel jom3a',
    'Bonjour, je voudrais un détartrage la semaine prochaine',
    'وقتاش تحلو؟',
  ];
  it.each(positives)('flags: %s', (t) => expect(isEmergency(t)).toBe(true));
  it.each(negatives)('does not flag: %s', (t) => expect(isEmergency(t)).toBe(false));
});
