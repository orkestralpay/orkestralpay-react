// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { mask, readConfig, readOrder, validCpf } from './server.mjs';

const buyer = {
  name: 'Maria', surname: 'Souza', document: '529.982.247-25', email: 'maria@example.com', phone: '(11) 98888-7777',
  postal_code: '01310-100', street: 'Av. Paulista', number: '1000', details: '', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP',
};

describe('demo store', () => {
  test('computes the total on the server from catalog prices, ignoring anything the browser sends as price', () => {
    const order = readOrder({ ...buyer, qty_cafe: '2', qty_caneca: '1', qty_coador: '0', price: '1', amount: '1' });

    expect(order.errors).toEqual([]);
    expect(order.amount).toBe(2 * 4990 + 5900);
  });

  test('caps quantities between 0 and 10', () => {
    expect(readOrder({ ...buyer, qty_cafe: '999', qty_caneca: '-5', qty_coador: '0' }).amount).toBe(10 * 4990);
  });

  test('rejects invalid buyer data and empty carts', () => {
    const order = readOrder({ ...buyer, document: '111.111.111-11', email: 'x', postal_code: '123', state: 'XX', qty_cafe: '0' });

    expect(order.errors).toEqual(expect.arrayContaining(['CPF inválido.', 'E-mail inválido.', 'CEP inválido.', 'Selecione o estado.', 'Adicione pelo menos um produto.']));
  });

  test('validates CPF check digits', () => {
    expect(validCpf('52998224725')).toBe(true);
    expect(validCpf('52998224726')).toBe(false);
  });

  test('requires the merchant credentials and URLs', () => {
    expect(() => readConfig({})).toThrow('Missing configuration');
  });

  test('masks card number, CVV, expiry and PSP keys in the recorded PSP calls', () => {
    const out = mask({ merchant: { apiKey: 'k', apiLogin: 'l' }, creditCard: { number: '4097440000000004', securityCode: '123', expirationDate: '2030/12', name: 'APPROVED' },
      Payment: { CreditCard: { CardNumber: '4024007197692931', SecurityCode: '123' } }, note: 'cartao 4097440000000004' });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/4097440000000004|4024007197692931|"123"|2030\/12/);
    expect(out.creditCard.number).toBe('**** **** **** 0004');
    expect(out.creditCard.name).toBe('APPROVED');
  });
});
