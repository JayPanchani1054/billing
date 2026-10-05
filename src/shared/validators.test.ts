import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isSacCode,
  normalizeIfsc,
  normalizeMobile,
  normalizePan,
  panEntityType,
  validateBankAccountNo,
  validateCin,
  validateEmail,
  validateGstinInput,
  validateHsnSac,
  validateIfsc,
  validateMobile,
  validatePan,
  validatePincode,
  validateTan,
  validateUpiId,
} from './validators.ts';

describe('PAN / TAN / CIN / GSTIN', () => {
  test('PAN format and holder type', () => {
    assert.equal(validatePan('ABCPE1234F'), null);
    assert.equal(validatePan(' abcpe1234f '), null, 'case and spaces are forgiven');
    assert.equal(normalizePan(' abcpe1234f '), 'ABCPE1234F');
    assert.match(validatePan('ABCXE1234F') ?? '', /holder type/);
    assert.match(validatePan('ABCP1234F') ?? '', /10 characters/);
    assert.match(validatePan('ABCPE12345') ?? '', /format is invalid/);
    assert.match(validatePan('') ?? '', /empty/);
    assert.equal(panEntityType('AAACR5055K'), 'Company');
    assert.equal(panEntityType('ABCPE1234F'), 'Individual');
    assert.equal(panEntityType('bad'), '');
  });

  test('TAN and CIN', () => {
    assert.equal(validateTan('MUMA12345B'), null);
    assert.notEqual(validateTan('MUM12345B'), null);
    assert.equal(validateCin('U72200MH2009PTC123456'), null);
    assert.equal(validateCin('L17110MH1973PLC019786'), null);
    assert.notEqual(validateCin('X72200MH2009PTC123456'), null);
  });

  test('GSTIN as a form field', () => {
    assert.equal(validateGstinInput('27AAPFU0939F1ZV'), null);
    assert.match(validateGstinInput('27AAPFU0939F1ZW') ?? '', /check character/);
  });
});

describe('banking', () => {
  test('IFSC', () => {
    assert.equal(validateIfsc('HDFC0001234'), null);
    assert.equal(validateIfsc('sbin0000691'), null);
    assert.equal(normalizeIfsc(' sbin0000691 '), 'SBIN0000691');
    assert.match(validateIfsc('HDFC1001234') ?? '', /format is invalid/, '5th character must be 0');
    assert.match(validateIfsc('HDFC000123') ?? '', /11 characters/);
  });

  test('UPI ID', () => {
    assert.equal(validateUpiId('shop.name@okhdfcbank'), null);
    assert.equal(validateUpiId('9876543210@ybl'), null);
    assert.notEqual(validateUpiId('shop@'), null);
    assert.notEqual(validateUpiId('@upi'), null);
    assert.notEqual(validateUpiId('a b@upi'), null);
    assert.notEqual(validateUpiId('shop@1bank'), null);
  });

  test('bank account number', () => {
    assert.equal(validateBankAccountNo('50100012345678'), null);
    assert.equal(validateBankAccountNo('5010 0012 3456'), null);
    assert.notEqual(validateBankAccountNo('12345'), null);
    assert.notEqual(validateBankAccountNo('ABCDEFGH'), null);
  });
});

describe('address and contact', () => {
  test('PIN code', () => {
    assert.equal(validatePincode('400001'), null);
    assert.equal(validatePincode('110 001'), null);
    assert.match(validatePincode('012345') ?? '', /cannot start with 0/);
    assert.match(validatePincode('40001') ?? '', /6 digits/);
    assert.match(validatePincode('40000A') ?? '', /6 digits/);
  });

  test('email', () => {
    assert.equal(validateEmail('accounts@example.com'), null);
    assert.equal(validateEmail('first.last+gst@mail.example.co.in'), null);
    assert.notEqual(validateEmail('accounts@'), null);
    assert.notEqual(validateEmail('accounts.example.com'), null);
    assert.notEqual(validateEmail('a@b@example.com'), null);
    assert.notEqual(validateEmail('.a@example.com'), null);
    assert.notEqual(validateEmail('a..b@example.com'), null);
    assert.notEqual(validateEmail('a@example'), null);
    assert.notEqual(validateEmail('a@-example.com'), null);
  });

  test('mobile', () => {
    for (const m of ['9876543210', '+91 98765 43210', '+919876543210', '919876543210', '09876543210', '98765-43210']) {
      assert.equal(validateMobile(m), null, m);
      assert.equal(normalizeMobile(m), '9876543210', m);
    }
    assert.notEqual(validateMobile('5876543210'), null, 'must start with 6–9');
    assert.notEqual(validateMobile('987654321'), null);
    assert.notEqual(validateMobile('+1 9876543210'), null);
    assert.match(validateMobile('') ?? '', /empty/);
  });
});

describe('HSN / SAC', () => {
  test('length and digits', () => {
    assert.equal(validateHsnSac('8471'), null);
    assert.equal(validateHsnSac('847130'), null);
    assert.equal(validateHsnSac('84713010'), null);
    assert.equal(validateHsnSac('998314'), null);
    assert.match(validateHsnSac('84713') ?? '', /4, 6 or 8 digits/);
    assert.match(validateHsnSac('84A1') ?? '', /digits only/);
    assert.match(validateHsnSac('0012') ?? '', /cannot start with 00/);
  });

  test('goods vs services', () => {
    assert.equal(validateHsnSac('998314', 'services'), null);
    assert.match(validateHsnSac('8471', 'services') ?? '', /start with 99/);
    assert.match(validateHsnSac('9983', 'goods') ?? '', /SAC/);
    assert.equal(isSacCode('998314'), true);
    assert.equal(isSacCode('8471'), false);
  });
});
