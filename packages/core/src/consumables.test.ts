import { describe, expect, it } from 'vitest';
import { classifyConsumable } from './consumables';

const c = (title: string, extra: { titleTranslated?: string; merchant?: string } = {}) => classifyConsumable({ title, ...extra });

describe('consumable suggestions', () => {
  it('finds food and drink in German and English', () => {
    expect(c('Seeberger Studentenfutter, 1er Pack (1 x 1 kg Packung)')).toBe('food');
    expect(c('Bio Zitronenmelisse 500g - Melissentee - lose')).toBe('food');
    expect(c('Monbana 100% Kakao Pulver 200g Dose')).toBe('food');
    expect(c('Evian natural mineral water 1.5L x12 · France import 1500ml x12 / case')).toBe('food');
    expect(c('Paifu mini donut rawhide dental dog chews · Mini donuts 84g (7-pack)')).toBe('food');
    expect(c('乌龙茶', { titleTranslated: 'Taiwan high-mountain oolong tea, 150g bag' })).toBe('food');
  });
  it('finds household supplies', () => {
    expect(c('Persil (Henkel) baby/sensitive-skin laundry liquid 2.5L')).toBe('supplies');
    expect(c('OHROPAX soft Schaumstoff Stoepsel, 10 St')).toBe('supplies');
    expect(c('Varta Batterien Mignon AA LR6 Vorratspack 40 Stück')).toBe('supplies');
  });
  it('takes everything from a grocery or delivery service as food, unless it is a thing', () => {
    expect(c('Kohlrabi 1 Stück', { merchant: 'REWE Lieferservice' })).toBe('food');
    expect(c('Pizza Bombay - Medium', { merchant: "Domino's" })).toBe('food');
    expect(c('Glass jug 2150ml', { merchant: 'Epermarket (Shanghai)' })).toBeNull();
  });
  it('does not take things that only sound like food', () => {
    for (const t of [
      'Kaffee-Kapselständer für Nespresso, 36 Kapseln',
      'Xiaomi smart coffee scale with timer',
      'Vintage cowhide belt with stainless pin buckle · Coffee',
      'Cast-iron teapot with ceramic stove, tea set',
      'Craft-Bier: Geschichte, Herstellung, Brauereien',
      'Potted rosemary, edible herb · Rosemary, large pot; potted',
      'KONG Classic treat-dispensing chew toy',
      'Sputnik adjustable breathable dog harness · Turmeric yellow',
      'E-PRANCE Permanenter Kaffeefilter Wiederverwendbare Handfilter',
    ]) expect(c(t), t).toBeNull();
  });
});
