const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
    res.json({ ok: true, msg: 'Funcionando!' });
});

app.get('/setup', async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE,
                password_hash VARCHAR(255),
                wallet_balance DECIMAL(10,2) DEFAULT 100
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS matches (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                bet_amount DECIMAL(10,2),
                final_multiplier DECIMAL(10,2) DEFAULT 1,
                total_hits INTEGER DEFAULT 0,
                result VARCHAR(20) DEFAULT 'in_progress',
                payout DECIMAL(10,2) DEFAULT 0
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS multiplier_config (
                id SERIAL PRIMARY KEY,
                hit_number INTEGER UNIQUE,
                base_multiplier DECIMAL(10,2),
                zone_size_percentage DECIMAL(5,2)
            )
        `);
        await pool.query(`
            INSERT INTO multiplier_config VALUES 
            (1,1,1.5,80),(2,2,2.0,70),(3,3,3.0,60),(4,4,5.0,50),
            (5,5,10.0,40),(6,6,20.0,30),(7,7,50.0,20),(8,8,100.0,10)
            ON CONFLICT DO NOTHING
        `);
        res.json({ ok: true, msg: 'Tabelas OK!' });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hash = await bcrypt.hash(password, 10);
        const r = await pool.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
            [email, hash]
        );
        res.json({ ok: true, user: r.rows[0] });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (!r.rows[0]) return res.json({ ok: false, erro: 'Email/senha errados' });
        
        const ok = await bcrypt.compare(password, r.rows[0].password_hash);
        if (!ok) return res.json({ ok: false, erro: 'Email/senha errados' });
        
        const token = jwt.sign({ userId: r.rows[0].id }, process.env.JWT_SECRET || 'secret', { expiresIn: '24h' });
        res.json({ ok: true, token, user: r.rows[0] });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.post('/api/game/start', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const u = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const { bet_amount } = req.body;
        
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [bet_amount, u.userId]);
        const m = await pool.query('INSERT INTO matches (user_id, bet_amount) VALUES ($1, $2) RETURNING id', [u.userId, bet_amount]);
        res.json({ ok: true, match_id: m.rows[0].id });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.post('/api/game/hit', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const u = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const { match_id } = req.body;
        
        const m = await pool.query('SELECT * FROM matches WHERE id = $1', [match_id]);
        const next = m.rows[0].total_hits + 1;
        const c = await pool.query('SELECT * FROM multiplier_config WHERE hit_number = $1', [next]);
        
        const hit = Math.random() * 100 <= c.rows[0].zone_size_percentage;
        
        if (hit) {
            await pool.query('UPDATE matches SET total_hits = $1, final_multiplier = $2 WHERE id = $3', 
                [next, c.rows[0].base_multiplier, match_id]);
            res.json({ ok: true, result: 'hit', mult: c.rows[0].base_multiplier });
        } else {
            await pool.query('UPDATE matches SET result = $1 WHERE id = $2', ['loss', match_id]);
            res.json({ ok: false, result: 'miss' });
        }
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.post('/api/game/cashout', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const u = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const { match_id } = req.body;
        
        const m = await pool.query('SELECT * FROM matches WHERE id = $1', [match_id]);
        const payout = m.rows[0].bet_amount * m.rows[0].final_multiplier;
        
        await pool.query('UPDATE matches SET result = $1, payout = $2 WHERE id = $3', ['win', payout, match_id]);
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [payout, u.userId]);
        
        res.json({ ok: true, payout });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.listen(PORT, () => console.log('Rodando porta ' + PORT));
