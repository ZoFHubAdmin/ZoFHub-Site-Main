-- Batch 1 of 1
insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked)
values
  ('snow-rider-3d', 'Snow Rider 3D', 'https://html5.gamedistribution.com/3b79a8537ebc414fb4f9672a9b8c68c8/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/3b79a8537ebc414fb4f9672a9b8c68c8-512x512.jpg', 'racing', true, now()),
  ('drift-king', 'Drift King', 'https://www.onlinegames.io/games/2024/unity/drift-king/index.html', 'https://www.onlinegames.io/media/posts/931/responsive/drift-king-2.webp', 'racing', true, now()),
  ('moto-x3m-bike-race', 'Moto X3M Bike Race', 'https://html5.gamedistribution.com/20473956346b412497645161048f020c/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/20473956346b412497645161048f020c-512x384.jpg', 'racing', true, now()),
  ('cube-surfer', 'Cube Surfer', 'https://html5.gamedistribution.com/01a1c2c5d52e4b4f9c6f8c3a4f3a2b1c/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/01a1c2c5d52e4b4f9c6f8c3a4f3a2b1c-512x512.jpg', 'arcade', true, now()),
  ('tunnel-rush', 'Tunnel Rush', 'https://html5.gamedistribution.com/001f3e30922b40658421a71f0081e891/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/001f3e30922b40658421a71f0081e891-512x384.jpg', 'arcade', true, now()),
  ('basket-random', 'Basket Random', 'https://html5.gamedistribution.com/13e9441113544116801912f71694f9e0/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/13e9441113544116801912f71694f9e0-512x384.jpg', 'sports', true, now()),
  ('soccer-random', 'Soccer Random', 'https://html5.gamedistribution.com/567f4078864a4750949a888806a66699/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/567f4078864a4750949a888806a66699-512x384.jpg', 'sports', true, now()),
  ('penalty-shooters-2', 'Penalty Shooters 2', 'https://html5.gamedistribution.com/264789f8167746358044702008e92582/?gd_sdk_referrer_url=https%3A%2F%2Feduame.com%2F', 'https://img.gamedistribution.com/264789f8167746358044702008e92582-512x384.jpg', 'sports', true, now())
on conflict (slug) do update set
  title = excluded.title,
  game_url = excluded.game_url,
  thumbnail_url = excluded.thumbnail_url,
  category = excluded.category,
  is_working = excluded.is_working,
  last_checked = excluded.last_checked,
  updated_at = now();

select count(*) as total_games from public.games;
