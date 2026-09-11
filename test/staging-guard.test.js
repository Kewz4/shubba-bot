'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuardedDiscord, LIVE_GUILD, STAGING_GUILD } = require('../scripts/staging-sync');

// scripts/staging-sync.js runs with a bot token that holds ADMINISTRATOR on the
// live server. assertStagingWrite() is the only thing between a remap bug and a
// change to a 6,000-member community. Every way a write could reach live is
// attacked here.

const LIVE_CHANNEL = '1433994315402838127';   // live #bug-report
const LIVE_ROLE = '1480084666408239379';
const STAGING_CHANNEL = '1600000000000000001';
const UNKNOWN_CHANNEL = '1600000000000000999';

function client() {
    const d = new GuardedDiscord();
    d.markLive([LIVE_CHANNEL, LIVE_ROLE]);
    d.markStagingChannel({ id: STAGING_CHANNEL, guild_id: STAGING_GUILD });
    return d;
}
const refuses = (d, method, route, body) =>
    assert.throws(() => d.assertStagingWrite(method, route, body), /REFUSED/, `${method} ${route} was allowed`);
const allows = (d, method, route, body) =>
    assert.doesNotThrow(() => d.assertStagingWrite(method, route, body), `${method} ${route} was refused`);

test('the ids are distinct — a copy-paste slip here would make live the target', () => {
    assert.notEqual(LIVE_GUILD, STAGING_GUILD);
    assert.equal(STAGING_GUILD, '1523847700037107742');
    assert.equal(LIVE_GUILD, '1433991244966658072');
});

test('any write to the live guild is refused, on every method', () => {
    const d = client();
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        refuses(d, m, `/guilds/${LIVE_GUILD}`);
        refuses(d, m, `/guilds/${LIVE_GUILD}/roles`);
        refuses(d, m, `/guilds/${LIVE_GUILD}/channels`);
        refuses(d, m, `/guilds/${LIVE_GUILD}/onboarding`);
    }
});

test('a live channel is refused even though /channels routes carry no guild', () => {
    const d = client();
    refuses(d, 'PATCH', `/channels/${LIVE_CHANNEL}`);
    refuses(d, 'DELETE', `/channels/${LIVE_CHANNEL}`);
    refuses(d, 'POST', `/channels/${LIVE_CHANNEL}/messages`);
});

test('a channel nobody has verified is refused — unknown is not the same as staging', () => {
    refuses(client(), 'PATCH', `/channels/${UNKNOWN_CHANNEL}`);
});

test('a live role id under the STAGING guild is still refused', () => {
    // The guild half of the route is fine; the id after it is live's.
    refuses(client(), 'PATCH', `/guilds/${STAGING_GUILD}/roles/${LIVE_ROLE}`);
});

test('a body that still carries a live id is refused — that is a missed remap', () => {
    const d = client();
    refuses(d, 'PATCH', `/channels/${STAGING_CHANNEL}`, {
        permission_overwrites: [{ id: LIVE_GUILD, type: 0, allow: '0', deny: '1024' }],
    });
    refuses(d, 'POST', `/guilds/${STAGING_GUILD}/channels`, { name: 'x', parent_id: LIVE_CHANNEL });
    refuses(d, 'PUT', `/guilds/${STAGING_GUILD}/onboarding`, { default_channel_ids: [STAGING_CHANNEL, LIVE_CHANNEL] });
});

test('routes that are neither a guild nor a channel are refused', () => {
    const d = client();
    refuses(d, 'POST', '/users/@me/channels');
    refuses(d, 'PATCH', '/applications/1465165237358559386/commands');
    refuses(d, 'DELETE', '/invites/abc');
    refuses(d, 'PATCH', `/webhooks/${STAGING_CHANNEL}`);
});

test('a lookalike prefix does not smuggle a live guild through', () => {
    const d = client();
    refuses(d, 'PATCH', `/guilds/${LIVE_GUILD}0`);                 // longer id
    refuses(d, 'PATCH', `/guilds/${STAGING_GUILD}/../${LIVE_GUILD}`);
});

test('a channel claiming to be staging while reporting another guild is rejected', () => {
    const d = new GuardedDiscord();
    assert.throws(() => d.markStagingChannel({ id: UNKNOWN_CHANNEL, guild_id: LIVE_GUILD }), /not staging/);
    refuses(d, 'PATCH', `/channels/${UNKNOWN_CHANNEL}`);
});

test('a live channel id can never be registered as staging', () => {
    const d = client();
    assert.throws(() => d.markStagingChannel({ id: LIVE_CHANNEL, guild_id: STAGING_GUILD }), /LIVE/);
});

test('every refusal is recorded for the report', () => {
    const d = client();
    try { d.assertStagingWrite('PATCH', `/guilds/${LIVE_GUILD}`); } catch {}
    assert.equal(d.refused.length, 1);
    assert.match(d.refused[0], new RegExp(LIVE_GUILD));
});

// And it must not be so paranoid that the sync cannot run.

test('ordinary staging writes are allowed', () => {
    const d = client();
    allows(d, 'PATCH', `/guilds/${STAGING_GUILD}`, { name: 'x' });
    allows(d, 'POST', `/guilds/${STAGING_GUILD}/roles`, { name: 'Helper' });
    allows(d, 'PATCH', `/guilds/${STAGING_GUILD}/roles/${STAGING_GUILD}`, { permissions: '0' });
    allows(d, 'PUT', `/guilds/${STAGING_GUILD}/onboarding`, { default_channel_ids: [STAGING_CHANNEL] });
    allows(d, 'PATCH', `/channels/${STAGING_CHANNEL}`, {
        permission_overwrites: [{ id: STAGING_GUILD, type: 0, allow: '0', deny: '1024' }],
    });
    allows(d, 'DELETE', `/channels/${STAGING_CHANNEL}`);
});

test('member overwrites (user ids) are not mistaken for live resources', () => {
    // A user id is the same in both servers and is not a live guild resource.
    allows(client(), 'PATCH', `/channels/${STAGING_CHANNEL}`, {
        permission_overwrites: [{ id: '422458713987612685', type: 1, allow: '1024', deny: '0' }],
    });
});

test('a base64 image is not scanned as if it were ids', () => {
    allows(client(), 'PATCH', `/guilds/${STAGING_GUILD}`, {
        icon: 'data:image/png;base64,' + Buffer.from(LIVE_GUILD.repeat(20)).toString('base64'),
    });
});

test('the dry run returns a stand-in and still enforces the guard', async () => {
    const d = client();
    const r = await d.req('POST', `/guilds/${STAGING_GUILD}/roles`, { name: 'x' });
    assert.equal(r.__dry, true, 'without --apply nothing may be sent');
    await assert.rejects(() => d.req('PATCH', `/guilds/${LIVE_GUILD}`, { name: 'x' }), /REFUSED/);
});
