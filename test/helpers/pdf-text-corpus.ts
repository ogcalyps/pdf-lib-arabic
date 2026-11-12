/**
 * Golden corpus: real-world Arabic and Persian lines (forms, prices, dates,
 * contracts) that each exercise a bidi or shaping rule. Shared by
 * test/engine.test.ts and test/font-stack.test.ts.
 */

export const RLM = String.fromCharCode(0x200f);
export const ZWNJ = String.fromCharCode(0x200c);

export interface CorpusEntry {
  id: string;
  text: string;
  /** Box direction; default 'auto'. */
  direction?: 'auto' | 'ltr' | 'rtl';
  /** Box width in points at 16 pt; default 480 (no wrapping for single lines). */
  width?: number;
  /** Expected number of lines, when the entry is meant to wrap. */
  lines?: number;
  /**
   * Hand-checked display order, left to right, marks left out, one string per
   * line. Independent of bidi-js, so these hold even if both sides of the
   * bidi-js comparison went wrong the same way.
   */
  visual?: string[];
}

/** A Hijri date as an Arabic UI writes it (1 July 2026): Arabic-Indic digits and the هـ suffix. */
export const HIJRI_SAMPLE = '١٦ محرم ١٤٤٨هـ';

export const WRAPPED_PARAGRAPH =
  'يرجى تعبئة هذا النموذج بالكامل وإرساله إلى قسم الموارد البشرية قبل 15 أكتوبر 2026، مع إرفاق صورة الهوية الوطنية (الوجهين).';

export const CORPUS: CorpusEntry[] = [
  { id: 'plain-arabic', text: 'يرجى التوقيع هنا والتاريخ في نهاية الصفحة' },
  { id: 'lam-alef', text: 'السلام عليكم، لأن الإسلام لا' },
  { id: 'harakat', text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ' },
  { id: 'mixed-latin-digits', text: 'أرسل ملف PDF قبل 15/03/2026 إلى info@example.com' },
  { id: 'arabic-indic-digits', text: 'المبلغ ٤٥٠٫٧٥ ريال', visual: ['لاير ٤٥٠٫٧٥ غلبملا'] },
  {
    id: 'price-percent',
    text: 'المبلغ: ٤٥٠٫٧٥ ريال (شامل الضريبة ١٥٪)',
    visual: ['(٪١٥ ةبيرضلا لماش) لاير ٤٥٠٫٧٥ :غلبملا'],
  },
  // ASCII % takes a different bidi path from ٪ (W6 after an Arabic number, not W5), so both digit kinds are covered.
  { id: 'percent-arabic-digits', text: 'خصم ١٥% على السعر', visual: ['رعسلا ىلع %١٥ مصخ'] },
  { id: 'percent-latin-digits', text: 'خصم 15% على السعر', visual: ['رعسلا ىلع %15 مصخ'] },
  { id: 'persian-zwnj', text: `گزارش سالانه ۱۴۰۳ را می${ZWNJ}خواهم`, visual: ['مهاوخیم ار ۱۴۰۳ هنالاس شرازگ'] },
  { id: 'english-punctuation', text: 'Hello (world)!', visual: ['Hello (world)!'] },
  { id: 'hijri-date', text: HIJRI_SAMPLE },
  { id: 'whatsapp-rlm', text: `${RLM}تم استلام المبلغ 250 ريال${RLM} شكرا لكم` },
  { id: 'brackets', text: 'عقد إيجار – الطرف الأول (المؤجر) والطرف الثاني [المستأجر]' },
  { id: 'brand', text: 'شكرا لاستخدامكم BlendPDF!' },
  { id: 'wrapped-paragraph', text: WRAPPED_PARAGRAPH, width: 300, lines: 3 },
  // Form fields, IDs, emails and clauses as people type them.
  { id: 'rt-name', text: 'الاسم الكامل: محمد عبد الله الأحمد' },
  { id: 'rt-dob', text: 'تاريخ الميلاد: 1990/03/15 — مكان الإصدار: الرياض' },
  { id: 'rt-id', text: 'رقم الهوية الوطنية 1023456789 صالحة حتى عام 2030' },
  { id: 'rt-declaration', text: 'أقر أنا الموقع أدناه بصحة البيانات المذكورة أعلاه، وأتحمل المسؤولية الكاملة.' },
  { id: 'rt-email', text: 'يرجى إرسال الملف بصيغة PDF إلى البريد info@example.com قبل نهاية الأسبوع.' },
  { id: 'rt-lease', text: 'عقد إيجار سكني – الطرف الأول (المؤجر) والطرف الثاني (المستأجر)' },
  { id: 'rt-clause', text: 'لا يجوز لأي طرف التنازل عن هذا العقد إلا بموافقة خطية مسبقة.' },
  { id: 'rt-persian', text: 'گزارش ماهانه پروژه — چهارشنبه ۱۴۰۳' },
];

export const FONT_SIZE = 16;
export const DEFAULT_WIDTH = 480;
