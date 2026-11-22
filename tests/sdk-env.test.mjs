import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dotenvValue, slugForm } from '../scripts/sdk-env.mjs';

describe('dotenvValue (as python-dotenv reads the SDK .env)', () => {
  it('reads a plain value, with spaces around = and CRLF line ends', () => {
    assert.equal(dotenvValue('A=1\r\nBOT_SLUG = weld-arm-ultron\r\nB=2\r\n', 'BOT_SLUG'), 'weld-arm-ultron');
  });

  it('takes the last assignment', () => {
    assert.equal(dotenvValue('BOT_SLUG=Old Rover\nBOT_SLUG=new-rover\n', 'BOT_SLUG'), 'new-rover');
  });

  it('keeps a quoted value as is, # included, and ends an unquoted one at " #"', () => {
    assert.equal(dotenvValue('BOT_SLUG="Rover #2"  # mine\n', 'BOT_SLUG'), 'Rover #2');
    assert.equal(dotenvValue("BOT_SLUG='Weld Arm Ultron '\n", 'BOT_SLUG'), 'Weld Arm Ultron ');
    assert.equal(dotenvValue('BOT_SLUG=weld-arm-ultron # the rover\n', 'BOT_SLUG'), 'weld-arm-ultron');
  });

  it('accepts an export prefix, ignores commented-out lines and other names', () => {
    assert.equal(dotenvValue('export BOT_SLUG=rover-one\n', 'BOT_SLUG'), 'rover-one');
    assert.equal(dotenvValue('# BOT_SLUG=old\nMY_BOT_SLUG=x\n', 'BOT_SLUG'), '');
  });
});

describe('slugForm', () => {
  it('turns a display name into the slug FrodoBots knows', () => {
    assert.equal(slugForm('Weld Arm Ultron'), 'weld-arm-ultron');
    assert.equal(slugForm('  Weld  Arm Ultron  '), 'weld-arm-ultron');
    assert.equal(slugForm('Rover-1'), 'rover-1');
  });

  it('leaves a slug alone', () => {
    assert.equal(slugForm('weld-arm-ultron'), null);
    assert.equal(slugForm('bot_7'), null);
    assert.equal(slugForm(''), null);
  });
});
