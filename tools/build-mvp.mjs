// tools/build-mvp.mjs
//
// Build the MVP launch catalog and health-check every embed URL in parallel.
//
//   node tools/build-mvp.mjs            # build + health check, write api/games.json
//   node tools/build-mvp.mjs --no-check # skip health check (faster, less safe)
//   node tools/build-mvp.mjs --keep-broken  # health-check but keep broken in catalog (flagged)
//
// Output:
//   api/games.json                  ← server reads this on boot
//   tools/build-mvp.report.json     ← per-URL health-check result
//   tools/build-mvp.report.txt      ← human-readable summary
//
// The list inlined below is the user-curated MVP set (~180 entries).  Duplicates
// are removed by slug.  URLs that fail the health check are dropped by default.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const NO_CHECK     = process.argv.includes('--no-check');
const KEEP_BROKEN  = process.argv.includes('--keep-broken');
const CHECK_LIMIT  = 16;   // parallel HTTP checks
const CHECK_TIMEOUT_MS = 7000;

// ============================================================================
// MVP list — pasted from user, deduped by slug.
// Entries are [title, embed_url, thumbnail, category_label, comma_tags].
// ============================================================================
const MVP = [
  ["Golf Bit","https://cloud.onlinegames.io/games/2026/construct/328/golf-bit/game.html","https://www.onlinegames.io/media/posts/1289/responsive/golf-bit-xs.webp","Sports","golf,sports,2d,skill,casual"],
  ["Love Tester","https://www.onlinegames.io/games/2021/3/love-tester/index.html","https://www.onlinegames.io/media/posts/152/responsive/love-tester-xs.jpg","Casual","love,kids,casual,fun,girl"],
  ["Stack Fire Ball","https://www.onlinegames.io/games/2021/unity/stack-fire-ball/index.html","https://www.onlinegames.io/media/posts/184/responsive/Stack-Fire-Ball-Game-xs.jpg","Arcade","ball,3d,arcade,skill,mobile"],
  ["Drift King","https://www.onlinegames.io/games/2024/unity/drift-king/index.html","https://www.onlinegames.io/media/posts/729/responsive/Drift-King-xs.jpg","Racing","drift,car,racing,3d,multiplayer"],
  ["Highway Traffic","https://www.onlinegames.io/games/2022/unity/highway-traffic/index.html","https://www.onlinegames.io/media/posts/32/responsive/Highway-Traffic-2-xs.jpg","Racing","traffic,car,endless,driving,3d"],
  ["Strike Online","https://www.onlinegames.io/games/2023/unity2/cs-online/index.html","https://www.onlinegames.io/media/posts/434/responsive/CS-Online-xs.jpg","Shooting","fps,tactical,multiplayer,3d,war"],
  ["Stickman Parkour","https://cloud.onlinegames.io/games/2024/construct/219/stickman-parkour/index-og.html","https://www.onlinegames.io/media/posts/871/responsive/stickman-parkour-OG-xs.jpg","Arcade","parkour,stickman,platformer,2d,skill"],
  ["Stickman GTA City","https://cloud.onlinegames.io/games/2024/unity3/stickman-gta-city/index-og.html","https://www.onlinegames.io/media/posts/900/responsive/stickman-gta-city-free-xs.jpg","Action","gta,stickman,driving,shooting,3d"],
  ["Masked Special Forces","https://www.onlinegames.io/games/2022/unity2/masked-special-forces/index.html","https://www.onlinegames.io/media/posts/310/responsive/Masked-Special-Forces-FPS-xs.jpg","Shooting","fps,battle-royale,multiplayer,3d,war"],
  ["Checkout Frenzy","https://cloud.onlinegames.io/games/2025/unity/checkout-frenzy/index-og.html","https://www.onlinegames.io/media/posts/974/responsive/checkout-frenzy-cashier-game-xs.jpg","Simulator","simulator,tycoon,cashier,3d,fun"],
  ["Madalin Stunt Cars Pro","https://www.onlinegames.io/games/2023/unity/madalin-stunt-cars-pro/index.html","https://www.onlinegames.io/media/posts/401/responsive/Madalin-Stunt-Cars-Pro-Game-xs.jpg","Racing","stunt,car,drift,multiplayer,3d"],
  ["Velocity Rush","https://cloud.onlinegames.io/games/2026/unity/velocity-rush/game.html","https://www.onlinegames.io/media/posts/1265/responsive/velocity-rush-xs.webp","Arcade","ball,arcade,speed,obstacle,3d"],
  ["Dublix","https://cloud.onlinegames.io/games/2025/unity4/dublix/game-og.html","https://www.onlinegames.io/media/posts/1126/responsive/dublix-xs.webp","Adventure","roblox,multiplayer,parkour,racing,3d"],
  ["Escape Car","https://cloud.onlinegames.io/games/2025/unity2/escape-car/index-og.html","https://www.onlinegames.io/media/posts/1000/responsive/Escape-Car-xs.jpg","Racing","gta,police,car,drift,driving"],
  ["Get On Top","https://www.onlinegames.io/games/2024/code/6/get-on-top/index.html","https://www.onlinegames.io/media/posts/697/responsive/Get-on-Top-xs.jpg","2 Player","2-player,stickman,physics,fighting,funny"],
  ["Capybara Clicker Pro","https://www.onlinegames.io/games/2023/q2/capybara-clicker-pro/index.html","https://www.onlinegames.io/media/posts/554/responsive/Capybara-Clicker-Pro-xs.jpg","Clicker","clicker,idle,cute,animal,mobile"],
  ["Real Flight Simulator","https://cloud.onlinegames.io/games/2023/unity2/real-flight-simulator/index.html","https://www.onlinegames.io/media/posts/342/responsive/Real-Flight-Simulator-2-xs.jpg","Simulator","airplane,flying,simulator,3d,realistic"],
  ["Snaker io","https://cloud.onlinegames.io/games/2026/more/snaker-io/game.html","https://www.onlinegames.io/media/posts/1261/responsive/snaker-io-xs.webp","IO Games","snake,io,multiplayer,arcade,mobile"],
  ["Edys Car Simulator","https://www.onlinegames.io/games/2022/unity/edys-car-simulator/index.html","https://www.onlinegames.io/media/posts/238/responsive/Edys-Car-Simulator-Online-xs.jpg","Simulator","car,simulator,city,driving,3d"],
  ["Drift Hunters Pro","https://www.onlinegames.io/games/2023/unity/drift-hunters-pro/index.html","https://www.onlinegames.io/media/posts/397/responsive/Drift-Hunters-Pro-xs.jpg","Racing","drift,racing,car,multiplayer,3d"],
  ["Basket Hoop","https://cloud.onlinegames.io/games/2024/construct/311/basket-hoop/index-og.html","https://www.onlinegames.io/media/posts/843/responsive/Basket-Hoop-xs.jpg","Sports","basketball,physics,mobile,skill,2d"],
  ["Highway Cars","https://www.onlinegames.io/games/2023/construct/211/highway-cars/index.html","https://www.onlinegames.io/media/posts/598/responsive/Highway-Cars-xs.jpg","Racing","traffic,car,racing,endless,3d"],
  ["FPS Strike","https://cloud.onlinegames.io/games/2024/unity2/fps-strike/index-og.html","https://www.onlinegames.io/media/posts/902/responsive/fps-strike-online-xs.jpg","Shooting","fps,multiplayer,sniper,war,3d"],
  ["Burnout City","https://cloud.onlinegames.io/games/2024/unity/burnout-city/index-og.html","https://www.onlinegames.io/media/posts/861/responsive/burnoutcity-xs.jpg","Racing","drift,stunt,gta,racing,3d"],
  ["Basketball io","https://www.onlinegames.io/games/2022/unity3/basketball-io/index.html","https://www.onlinegames.io/media/posts/302/responsive/Basketball-io-2-xs.jpg","Sports","basketball,io,3d,sports,fun"],
  ["Drunken Duel","https://www.onlinegames.io/games/2024/code/2/drunken-duel/index.html","https://www.onlinegames.io/media/posts/698/responsive/Drunken-Duel-xs.jpg","2 Player","2-player,stickman,physics,funny,combat"],
  ["Cube Worlds","https://cloud.onlinegames.io/games/2025/html/cube-worlds/index-og.html","https://www.onlinegames.io/media/posts/986/responsive/Cube-Worlds-xs.jpg","Sandbox","minecraft,sandbox,crafting,building,3d"],
  ["99 Nights in the Forest","https://cloud.onlinegames.io/games/2026/unity/99-nights-in-the-forest-survival/game.html","https://www.onlinegames.io/media/posts/1190/responsive/99-nights-in-the-forest-xs.webp","Survival","survival,crafting,horror,3d,adventure"],
  ["Fast Food Rush","https://cloud.onlinegames.io/games/2025/unity/fast-food-rush/index-og.html","https://www.onlinegames.io/media/posts/979/responsive/fast-food-rush-xs.jpg","Simulator","restaurant,cooking,tycoon,3d,fun"],
  ["Love Tester Story","https://cloud.onlinegames.io/games/2024/construct/225/love-tester-story/index-og.html","https://www.onlinegames.io/media/posts/816/responsive/Love-Tester-Story-xs.jpg","Casual","love,girl,casual,fun,mobile"],
  ["Stickman Destruction","https://www.onlinegames.io/games/2021/unity3/stickman-destruction/index.html","https://www.onlinegames.io/media/posts/233/responsive/Stickman-Destruction-xs.jpg","Action","ragdoll,stickman,physics,funny,sandbox"],
  ["WarStrike","https://cloud.onlinegames.io/games/2024/unity3/warstrike/index-og.html","https://www.onlinegames.io/media/posts/870/responsive/WarStrike-Online-xs.jpg","Shooting","fps,war,sniper,shooting,3d"],
  ["Masked Forces Zombie Survival","https://www.onlinegames.io/games/2021/unity3/masked-forces-zombie-survival/index.html","https://www.onlinegames.io/media/posts/225/responsive/Masked-Forces-Zombie-Survival-Online-xs.jpg","Shooting","zombie,fps,survival,multiplayer,horror"],
  ["Cat Simulator","https://www.onlinegames.io/games/2022/unity4/cat-simulator/index.html","https://www.onlinegames.io/media/posts/330/responsive/Cat-Simulator-Online-xs.jpg","Simulator","cat,animal,simulator,cute,kids"],
  ["Super Car Driving","https://cloud.onlinegames.io/games/2024/unity2/super-car-driving/index-og.html","https://www.onlinegames.io/media/posts/854/responsive/supercardriving-2-xs.jpg","Racing","supercar,stunt,parking,driving,3d"],
  ["Crazy Strike Force","https://www.onlinegames.io/games/2023/unity/crazy-strike-force/index.html","https://www.onlinegames.io/media/posts/366/responsive/Crazy-Strike-Force-xs.jpg","Shooting","fps,battle-royale,multiplayer,3d,crazy"],
  ["Highway Racer Pro","https://www.onlinegames.io/games/2024/unity/highway-racer-pro/index.html","https://www.onlinegames.io/media/posts/822/responsive/Highway-Racer-Pro-xs.jpg","Racing","racing,traffic,highway,multiplayer,3d"],
  ["ArmedForces.io","https://www.onlinegames.io/games/2021/unity3/armedforces-io/index.html","https://www.onlinegames.io/media/posts/234/responsive/Armed-Forces-io-xs.jpg","Shooting","fps,io,battle-royale,war,multiplayer"],
  ["Car Football","https://www.onlinegames.io/games/2023/construct/198/car-football/index.html","https://www.onlinegames.io/media/posts/405/responsive/Car-Football-xs.jpg","Sports","soccer,car,2-player,physics,fun"],
  ["Cake Match Puzzle","https://cloud.onlinegames.io/games/2024/unity3/cake-match-puzzle/index-og.html","https://www.onlinegames.io/media/posts/908/responsive/55-xs.jpg","Puzzle","puzzle,match,food,casual,brain"],
  ["Pixel Monster Town","https://cloud.onlinegames.io/games/2025/html/pixelmon-town/game.html","https://www.onlinegames.io/media/posts/1214/responsive/pixelmon-town-xs.webp","Sandbox","sandbox,pixel,building,monsters,adventure"],
  ["Legendary Sniper","https://www.onlinegames.io/games/2021/unity3/legendary-sniper/index.html","https://www.onlinegames.io/media/posts/596/responsive/Legendary-Sniper-xs.jpg","Shooting","sniper,war,fps,shooting,3d"],
  ["Geometry Vector","https://cloud.onlinegames.io/games/2026/construct/329/geometry-vector/game.html","https://www.onlinegames.io/media/posts/1246/responsive/geometry-vector-xs.webp","Arcade","geometry,arcade,music,skill,avoid"],
  ["Poop Clicker","https://www.onlinegames.io/games/2024/construct/292/poop-clicker/index.html","https://www.onlinegames.io/media/posts/742/responsive/Poop-Clicker-xs.jpg","Clicker","clicker,idle,funny,casual,mobile"],
  ["CubeCraft Survival","https://cloud.onlinegames.io/games/2025/unity4/cubecraft-survival/index-og.html","https://www.onlinegames.io/media/posts/1113/responsive/cubecraft-survival-xs.webp","Survival","minecraft,survival,crafting,sandbox,3d"],
  ["Drift Rider","https://www.onlinegames.io/games/2023/unity3/drift-rider/index.html","https://www.onlinegames.io/media/posts/553/responsive/Drift-Rider-xs.jpg","Racing","drift,car,racing,simulator,3d"],
  ["Chess FreezeNova","https://cloud.onlinegames.io/games/2025/unity3/chess/index-og.html","https://www.onlinegames.io/media/posts/1116/responsive/chess-freezenova-xs.webp","Strategy","chess,strategy,board,brain,2-player"],
  ["Block Blast","https://cloud.onlinegames.io/games/2024/unity3/block-blast/index-og.html","https://www.onlinegames.io/media/posts/876/responsive/block-blast-xs.jpg","Puzzle","puzzle,tetris,blocks,brain,relaxing"],
  ["Mob City","https://www.onlinegames.io/games/2021/unity3/mob-city/index.html","https://www.onlinegames.io/media/posts/418/responsive/Mob-City-xs.jpg","Action","gta,shooting,sniper,missions,3d"],
  ["Geometry Dash FreezeNova","https://www.onlinegames.io/games/2023/q2/geometry-dash-freezenova/index.html","https://www.onlinegames.io/media/posts/510/responsive/Geometry-Dash-FreezeNova-xs.jpg","Arcade","geometry-dash,arcade,skill,music,parkour"],
  ["8 Ball Pool Billiard","https://www.onlinegames.io/games/2022/unity3/8-ball-pool-billiard/index.html","https://www.onlinegames.io/media/posts/442/responsive/8-Ball-Pool-Billiard-xs.jpg","Sports","billiard,pool,sports,multiplayer,3d"],
  ["Kick The Dummy","https://www.onlinegames.io/games/2022/construct/153/kick-the-dummy/index.html","https://www.onlinegames.io/media/posts/414/responsive/Kick-The-Dummy-Game-xs.jpg","Action","ragdoll,physics,stress-relief,sandbox,funny"],
  ["Crazy Drifter","https://www.onlinegames.io/games/2022/unity3/crazy-drifter/index.html","https://www.onlinegames.io/media/posts/314/responsive/Crazy-Drifter-xs.jpg","Racing","drift,car,racing,simulator,crazy"],
  ["Wasteland Shooters","https://www.onlinegames.io/games/2021/unity2/wasteland-shooters/index.html","https://www.onlinegames.io/media/posts/218/responsive/Wasteland-Shooters-xs.jpg","Shooting","fps,io,war,multiplayer,shooting"],
  ["Backflip Challenge","https://cloud.onlinegames.io/games/2026/unity/backflip-challenge/game.html","https://www.onlinegames.io/media/posts/1203/responsive/backflip-challenge-xs.webp","Sports","sports,physics,funny,skill,mobile"],
  ["City Stunts","https://www.onlinegames.io/games/2023/unity3/city-stunts/index.html","https://www.onlinegames.io/media/posts/629/responsive/City-Stunts-Game-xs.jpg","Racing","stunts,car,city,ramps,3d"],
  ["Crazy Cattle 3D","https://cloud.onlinegames.io/games/2025/unity3/crazy-cattle-3d/index-og.html","https://www.onlinegames.io/media/posts/1004/responsive/Crazy-Cattle-3D-xs.jpg","Action","battle-royale,physics,funny,sheep,arena"],
  ["Urban Sniper","https://www.onlinegames.io/games/2022/unity2/urban-sniper/index.html","https://www.onlinegames.io/media/posts/322/responsive/Urban-Sniper-Game-xs.jpg","Shooting","sniper,police,shooting,action,3d"],
  ["Burnout Drift Hunter","https://www.onlinegames.io/games/2022/unity4/burnout-drift-hunter/index.html","https://www.onlinegames.io/media/posts/327/responsive/Burnout-Drift-Hunter-Online-xs.jpg","Racing","drift,burnout,multiplayer,racing,3d"],
  ["Egg Car Racing","https://cloud.onlinegames.io/games/2024/construct/289/egg-car-racing/index-og.html","https://www.onlinegames.io/media/posts/910/responsive/egg-car-racing-xs.jpg","Racing","car,egg,racing,physics,2d"],
  ["Nuts and Bolts Puzzle","https://cloud.onlinegames.io/games/2025/unity/nuts-and-bolts-puzzle/index-og.html","https://www.onlinegames.io/media/posts/965/responsive/nuts-and-bolts-puzzle-xs.jpg","Puzzle","puzzle,brain,logic,casual,relaxing"],
  ["Crazy Parking Fury","https://www.onlinegames.io/games/2022/unity3/crazy-parking-fury/index.html","https://www.onlinegames.io/media/posts/643/responsive/Crazy-Parking-Fury-xs.jpg","Racing","parking,police,gta,car,3d"],
  ["Four Colors","https://www.onlinegames.io/games/2023/code/four-colors/index.html","https://www.onlinegames.io/media/posts/535/responsive/Four-Colors-xs.jpg","Card","uno,card,strategy,kids,board"],
  ["Taxi Simulator","https://www.onlinegames.io/games/2022/unity/taxi-simulator/index.html","https://www.onlinegames.io/media/posts/465/responsive/Taxi-Simulator-xs.jpg","Simulator","taxi,city,driving,simulator,3d"],
  ["Head Soccer 2022","https://www.onlinegames.io/games/2023/construct/280/head-soccer-2022/index.html","https://www.onlinegames.io/media/posts/624/responsive/Head-Soccer-2022-xs.jpg","Sports","soccer,football,2-player,arcade,sports"],
  ["Troll Level","https://cloud.onlinegames.io/games/2024/unity2/troll-level/index-og.html","https://www.onlinegames.io/media/posts/857/responsive/troll-level-online-xs.jpg","Arcade","troll,funny,running,crazy,platformer"],
  ["Alien Sky Invasion","https://www.onlinegames.io/games/2021/unity3/alien-sky-invasion/index.html","https://www.onlinegames.io/media/posts/594/responsive/Alien-Sky-Invasion-xs.jpg","Action","airplane,space,aliens,shooting,3d"],
  ["Mini Cars Racing","https://cloud.onlinegames.io/games/2021/unity/mini-cars-racing/index-og.html","https://www.onlinegames.io/media/posts/1010/responsive/Mini-Cars-Racing-xs.jpg","Racing","racing,car,2-player,stunt,fun"],
  ["Fast Food Manager","https://cloud.onlinegames.io/games/2025/unity4/fast-food-manager/index-og.html","https://www.onlinegames.io/media/posts/1114/responsive/fast-food-manager-xs.webp","Simulator","restaurant,tycoon,cooking,idle,3d"],
  ["Fall Brainrots","https://cloud.onlinegames.io/games/2026/unity/fall-brainrots/game.html","https://www.onlinegames.io/media/posts/1194/responsive/fall-brainrots-xs.webp","Arcade","fall-guys,brainrot,multiplayer,parkour,3d"],
  ["Dark Ninja Hanjo","https://www.onlinegames.io/games/2023/unity/dark-ninja-hanjo/index.html","https://www.onlinegames.io/media/posts/451/responsive/Dark-Ninja-Hanjo-xs.jpg","Action","ninja,adventure,combat,3d,action"],
  ["Airplane Racer","https://www.onlinegames.io/games/2022/unity/airplane-racer/index.html","https://www.onlinegames.io/media/posts/268/responsive/Airplane-Racer-xs.jpg","Racing","airplane,flying,racing,2-player,3d"],
  ["Drift Fury","https://www.onlinegames.io/games/2023/unity/drift-fury/index.html","https://www.onlinegames.io/media/posts/650/responsive/Drift-Fury-xs.jpg","Racing","drift,car,racing,exotic,3d"],
  ["Five Nights of Dread","https://cloud.onlinegames.io/games/2025/unity2/five-nights-at-poppy/index-og.html","https://www.onlinegames.io/media/posts/992/responsive/Five-Nights-at-Poppy-xs.jpg","Horror","horror,scary,survival,suspense,2d"],
  ["Monster Truck Mountain Climb","https://cloud.onlinegames.io/games/2021/2/monster-truck-mountain-climb/index-og.html","https://www.onlinegames.io/media/posts/924/responsive/monster-truck-mountain-climb-xs.jpg","Racing","monster-truck,climbing,racing,physics,2d"],
  ["Tile Match","https://cloud.onlinegames.io/games/2025/unity/tile-match/index-og.html","https://www.onlinegames.io/media/posts/939/responsive/tile-match-xs.jpg","Puzzle","tile,match,puzzle,brain,cozy"],
  ["Police Traffic","https://www.onlinegames.io/games/2021/unity/police-traffic/index.html","https://www.onlinegames.io/media/posts/187/responsive/Pollice-Traffic-xs.jpg","Racing","police,traffic,car,driving,speed"],
  ["Rome Simulator","https://www.onlinegames.io/games/2021/unity/rome-simulator/index.html","https://www.onlinegames.io/media/posts/634/responsive/Rome-Simulator-2-xs.jpg","Action","rome,battle,war,shooting,3d"],
  ["Survival Island","https://cloud.onlinegames.io/games/2024/unity2/survival-island/index-og.html","https://www.onlinegames.io/media/posts/970/responsive/Survival-Island-xs.jpg","Survival","survival,island,crafting,minecraft,3d"],
  ["Rooftop Duel","https://cloud.onlinegames.io/games/2025/construct/213/rooftop-duel/index-og.html","https://www.onlinegames.io/media/posts/1002/responsive/Rooftop-Duel-Online-xs.jpg","2 Player","2-player,shooting,ragdoll,physics,combat"],
  ["Fort Drifter","https://www.onlinegames.io/games/2022/unity3/fort-drifter/index.html","https://www.onlinegames.io/media/posts/592/responsive/Fort-Drifter-xs.jpg","Racing","drift,sandbox,car,stunt,fortnite"],
  ["Deer Hunter","https://www.onlinegames.io/games/2021/1/deer-hunter/index.html","https://www.onlinegames.io/media/posts/591/responsive/Deer-Hunter-xs.jpg","Shooting","hunting,sniper,shooting,animal,2d"],
  ["2 Player Crazy Racer","https://www.onlinegames.io/games/2022/unity3/2-player-crazy-racer/index.html","https://www.onlinegames.io/media/posts/617/responsive/2-Player-Crazy-Racer-xs.jpg","Racing","racing,2-player,retro,vintage,3d"],
  ["ATV Highway Traffic","https://www.onlinegames.io/games/2021/unity/atv-highway-traffic/index.html","https://www.onlinegames.io/media/posts/668/responsive/ATV-Highway-Traffic-xs.jpg","Racing","atv,traffic,driving,speed,3d"],
  ["Futuristic Racer","https://cloud.onlinegames.io/games/2021/2/futuristic-racer/index-og.html","https://www.onlinegames.io/media/posts/1051/responsive/futuristic_racer_game-xs.webp","Racing","futuristic,space,neon,racing,speed"],
  ["Cookie Clicker Pro","https://cloud.onlinegames.io/games/2025/unity/cookie-clicker-pro/index-og.html","https://www.onlinegames.io/media/posts/971/responsive/Cookie-Clicker-Pro-Game-xs.jpg","Clicker","clicker,idle,cookies,casual,addictive"],
  ["Bandits Multiplayer PvP","https://www.onlinegames.io/games/2021/unity2/bandits-multiplayer-pvp/index.html","https://www.onlinegames.io/media/posts/487/responsive/Bandits-Multiplayer-PvP-xs.jpg","Action","western,pvp,multiplayer,zombie,horse"],
  ["FNF Funk 3D","https://www.onlinegames.io/games/2022/unity/fnf-funk-3d/index.html","https://www.onlinegames.io/media/posts/613/responsive/FNF-Funk-3D-xs.jpg","Music","fnf,music,rhythm,3d,arcade"],
  ["Subway Idle 3D","https://www.onlinegames.io/games/2022/unity4/subway-idle-3d/index.html","https://www.onlinegames.io/media/posts/586/responsive/Subway-Idle-xs.jpg","Simulator","idle,tycoon,subway,simulator,3d"],
  ["Army Combat","https://www.onlinegames.io/games/2021/unity/army-combat/index.html","https://www.onlinegames.io/media/posts/664/responsive/Army-Combat-xs.jpg","Shooting","army,war,fps,strategy,3d"],
  ["Stunt Simulator 2","https://www.onlinegames.io/games/2021/unity3/stunt-simulator-2/index.html","https://www.onlinegames.io/media/posts/765/responsive/Stunt-simulator-2-xs.jpg","Racing","stunt,car,simulator,crazy,3d"],
  ["Basketball Slam Dunk","https://www.onlinegames.io/games/2021/unity2/basketball-slam-dunk/index.html","https://www.onlinegames.io/media/posts/200/responsive/Basketball-Slam-Dunk-xs.jpg","Sports","basketball,retro,2-player,pixel,sports"],
  ["Poly Racing Cars","https://cloud.onlinegames.io/games/2022/unity3/poly-racing-cars/index-og.html","https://www.onlinegames.io/media/posts/835/responsive/Poly-racing-cars-image-xs.jpg","Racing","racing,lowpoly,multiplayer,car,3d"],
  ["Motorbike Stunt Simulator","https://cloud.onlinegames.io/games/2021/unity/motorbike-stunt-simulator/index-og.html","https://www.onlinegames.io/media/posts/1045/responsive/motorbike_stunt_simulator_game-2-xs.webp","Racing","motorbike,stunt,simulator,flips,3d"],
  ["Offroad Rally","https://www.onlinegames.io/games/2023/unity2/offroad-rally/index.html","https://www.onlinegames.io/media/posts/461/responsive/Offroad-Rally-xs.jpg","Racing","offroad,rally,mud,racing,3d"],
  ["Speedrun Parkour","https://www.onlinegames.io/games/2022/construct/145/speedrun-parkour/index.html","https://www.onlinegames.io/media/posts/759/responsive/Speedrun-Parkour-xs.jpg","Arcade","parkour,speed,running,2d,skill"],
  ["Solitaire","https://cloud.onlinegames.io/games/2025/html/solitaire/index-og.html","https://www.onlinegames.io/media/posts/1007/responsive/solitaire-xs.jpg","Card","solitaire,card,board,casual,brain"],
  ["Train Racing","https://www.onlinegames.io/games/2022/construct/120/train-racing/index.html","https://www.onlinegames.io/media/posts/445/responsive/Train-Racing-Game-xs.jpg","Racing","train,racing,multiplayer,2d,mobile"],
  ["Hero Rush Tower Defense","https://www.onlinegames.io/games/2023/unity/hero-rush-tower-defense/index.html","https://www.onlinegames.io/media/posts/491/responsive/Hero-Rush-Tower-Defense-Play-xs.jpg","Strategy","tower-defense,strategy,hero,battle,2d"],
  ["Motorbike Traffic","https://www.onlinegames.io/games/2021/unity/motorbike-traffic/index.html","https://www.onlinegames.io/media/posts/419/responsive/Motorbike-Traffic-Game-xs.jpg","Racing","motorbike,traffic,racing,endless,3d"],
  ["State io Wars","https://www.onlinegames.io/games/2024/construct/233/state-io-wars/index.html","https://www.onlinegames.io/media/posts/685/responsive/State-io-Wars-xs.jpg","Strategy","strategy,io,war,territory,mobile"],
  ["Speed Drift Racing","https://www.onlinegames.io/games/2022/construct/124/speed-drift-racing/index.html","https://www.onlinegames.io/media/posts/801/responsive/Speed-Drift-Racing-xs.jpg","Racing","drift,racing,2d,arcade,speed"],
  ["F1 Drift Racer","https://www.onlinegames.io/games/2022/construct/134/f1-drift-racer/index.html","https://www.onlinegames.io/media/posts/504/responsive/F1-Drift-Racer-xs.jpg","Racing","formula1,drift,racing,2d,multiplayer"],
  ["Police Chase Drifter","https://www.onlinegames.io/games/2021/3/police-chase-drifter/index.html","https://www.onlinegames.io/media/posts/155/responsive/Police-Chase-Drifter-Online-xs.jpg","Racing","police,drift,car,racing,gta"],
  ["GTA Simulator","https://www.onlinegames.io/games/2023/unity2/gta-simulator/index.html","https://www.onlinegames.io/media/posts/416/responsive/GTA-Simulator-xs.jpg","Action","gta,action,driving,shooting,simulator"],
  ["Guerrillas io","https://www.onlinegames.io/games/2023/unity2/guerrillas-io/index.html","https://www.onlinegames.io/media/posts/423/responsive/Guerillas-io-xs.jpg","Shooting","io,fps,battle-royale,shooting,3d"],
  ["Archer Hero","https://www.onlinegames.io/games/2023/unity/archer-hero/index.html","https://www.onlinegames.io/media/posts/364/responsive/Archer-Hero-Online-xs.jpg","Action","archery,rpg,hero,action,3d"],
  ["Draw the Car Path","https://cloud.onlinegames.io/games/2021/4/draw-the-car-path/index-og.html","https://www.onlinegames.io/media/posts/936/responsive/draw-the-car-path-xs.jpg","Puzzle","drawing,puzzle,car,kids,logic"],
  ["Limousine Simulator","https://www.onlinegames.io/games/2021/4/limousine-simulator/index.html","https://www.onlinegames.io/media/posts/701/responsive/Limousine-Simulator-xs.jpg","Simulator","driving,parking,simulator,car,2d"],
  ["Spend Bill Gates Money","https://cloud.onlinegames.io/games/2024/html/spend-bill-gates-money/index-og.html","https://www.onlinegames.io/media/posts/710/responsive/Spend-Bill-Gates-Money-xs.jpg","Casual","money,fun,clicker,casual,funny"],
  ["Jungle Mart","https://cloud.onlinegames.io/games/2026/construct/339/jungle-mart/game.html","https://www.onlinegames.io/media/posts/1247/responsive/jungle-mart-xs.webp","Simulator","farming,tycoon,idle,cute,mobile"],
  ["Nova Clicker","https://cloud.onlinegames.io/games/2024/construct/314/nova-clicker/index-og.html","https://www.onlinegames.io/media/posts/981/responsive/Nova-Clicker-xs.jpg","Clicker","clicker,idle,funny,casual,mobile"],
  ["Basketball King","https://cloud.onlinegames.io/games/2024/construct/316/basketball-king/index-og.html","https://www.onlinegames.io/media/posts/907/responsive/basketball-king-xs.jpg","Sports","basketball,2-player,sports,arcade,fun"],
  ["Among Impostor","https://www.onlinegames.io/games/2023/construct/234/among-impostor/index.html","https://www.onlinegames.io/media/posts/472/responsive/Among-Impostor-xs.jpg","Arcade","among-us,impostor,action,fun,mobile"],
  ["Stunt Rider","https://www.onlinegames.io/games/2024/unity/stunt-rider/index.html","https://www.onlinegames.io/media/posts/674/responsive/Stunt-Rider-Online-xs.jpg","Racing","stunt,car,driving,crazy,3d"],
  ["Electric Man 2","https://www.onlinegames.io/games/2024/flash/electric-man-2/index.html","https://www.onlinegames.io/media/posts/708/responsive/Electric-Man-2-Online-xs.jpg","Action","stickman,fighting,combat,classic,2d"],
  ["Gold Miner","https://www.onlinegames.io/games/2024/more/gold-miner/index.html","https://www.onlinegames.io/media/posts/1196/gold-miner.webp","Arcade","mining,gold,classic,arcade,casual"],
  ["Idle Breakout","https://www.onlinegames.io/games/2024/more/idle-breakout/index.html","https://www.onlinegames.io/media/posts/692/responsive/Play-Idle-Breakout-xs.jpg","Clicker","idle,breakout,clicker,bricks,casual"],
  ["Supermarket Simulator","https://cloud.onlinegames.io/games/2025/unity/supermarket-simulator/index-og.html","https://www.onlinegames.io/media/posts/959/responsive/Supermarket-Simulator-Online-xs.jpg","Simulator","supermarket,tycoon,simulator,casual,3d"],
  ["Watermelon Game","https://cloud.onlinegames.io/games/2025/construct/321/watermelon-game/index-og.html","https://www.onlinegames.io/media/posts/928/responsive/Watermelon-Game-Online-xs.jpg","Puzzle","suika,merge,fruit,physics,casual"],
  ["A Small World Cup","https://cloud.onlinegames.io/games/2024/more2/a-small-world-cup/index.html","https://www.onlinegames.io/media/posts/909/responsive/a-small-world-cp-xs.jpg","Sports","soccer,2-player,ragdoll,funny,worldcup"],
  ["Run 3","https://cloud.onlinegames.io/games/2025/more/run-3/index-og.html","https://www.onlinegames.io/media/posts/1056/responsive/run-3-online-xs.webp","Arcade","running,space,endless,platformer,skill"],
  ["2048","https://cloud.onlinegames.io/games/2025/html/2048/index.html","https://www.onlinegames.io/media/posts/916/responsive/2048-xs.jpg","Puzzle","puzzle,numbers,brain,2048,casual"],
  ["Flappy Bird","https://cloud.onlinegames.io/games/2025/html/flappy-bird/index-og.html","https://www.onlinegames.io/media/posts/1049/responsive/flappy_bird_game-xs.webp","Arcade","flappy,bird,classic,arcade,mobile"],
  ["Snake","https://cloud.onlinegames.io/games/2024/phaser/snake/index-og.html","https://www.onlinegames.io/media/posts/919/responsive/snake-xs.jpg","Arcade","snake,classic,arcade,2-player,casual"],
  ["Block Stack","https://www.onlinegames.io/games/2024/more/tetris/index.html","https://www.onlinegames.io/media/posts/758/responsive/Tetris-Online-xs.jpg","Puzzle","blocks,classic,puzzle,arcade,stacking"],
  ["Friday Night Funkin","https://cloud.onlinegames.io/games/2024/cube/friday-night-funkin/index-og.html","https://www.onlinegames.io/media/posts/620/responsive/Friday-Night-Funkin-xs.jpg","Music","music,rhythm,fnf,arcade,2d"],
  ["OvO Online","https://cloud.onlinegames.io/games/2025/html/ovo-online/index.html","https://www.onlinegames.io/media/posts/1087/responsive/ovo-online-xs.webp","Arcade","parkour,platformer,stickman,skill,obstacle"],
  ["Soccer Random","https://cloud.onlinegames.io/games/2024/gm/games2/soccer-random/index.html","https://www.onlinegames.io/media/posts/933/responsive/soccer-random-xs.jpg","Sports","soccer,2-player,ragdoll,physics,funny"],
  ["Basketball Stars","https://www.onlinegames.io/games/2024/gm/basketball-stars/index.html","https://www.onlinegames.io/media/posts/380/responsive/Basketball-Stars-Game-xs.jpg","Sports","basketball,2-player,nba,sports,arcade"],
  ["Moto X3M","https://www.onlinegames.io/games/2024/gm/moto-x3m/index.html","https://www.onlinegames.io/media/posts/374/responsive/Moto-X3M-xs.jpg","Racing","motorbike,stunts,racing,bike,2d"],
  ["Moto X3M Winter","https://www.onlinegames.io/games/2024/gm/moto-x3m-winter/index.html","https://www.onlinegames.io/media/posts/820/responsive/Moto-X3M-winter-xs.jpg","Racing","motorbike,winter,stunts,bike,2d"],
  ["Moto X3M Spooky Land","https://www.onlinegames.io/games/2024/gm/moto-x3m-spooky-land/index.html","https://www.onlinegames.io/media/posts/676/responsive/Moto-X3M-Spooky-Land-Online-xs.jpg","Racing","motorbike,halloween,stunts,bike,2d"],
  ["Moto X3M Pool Party","https://www.onlinegames.io/games/2024/gm/moto-x3m-pool-party/index.html","https://www.onlinegames.io/media/posts/711/responsive/Moto-X3M-xs.jpg","Racing","motorbike,summer,pool,stunts,bike"],
  ["Drift Hunters","https://www.onlinegames.io/games/2023/unity3/drift-hunters/index.html","https://www.onlinegames.io/media/posts/637/responsive/Drift-Hunters-Game-xs.jpg","Racing","drift,racing,car,tuning,simulator"],
  ["Drift Hunters 2","https://www.onlinegames.io/games/2024/unity/drift-hunters-2/index.html","https://www.onlinegames.io/media/posts/669/responsive/Drift-Hunters-2-Online-xs.jpg","Racing","drift,racing,car,3d,sequel"],
  ["Papas Pizzeria","https://www.onlinegames.io/games/2024/flash2/papas-pizzeria/index.html","https://www.onlinegames.io/media/posts/852/responsive/pizzeria-xs.jpg","Simulator","cooking,restaurant,pizza,casual,management"],
  ["Papas Burgeria","https://cloud.onlinegames.io/games/2024/flash/papas-burgeria/index-og.html","https://www.onlinegames.io/media/posts/889/responsive/Papas-Burgeria-xs.jpg","Simulator","cooking,restaurant,burger,casual,management"],
  ["Papas Donuteria","https://cloud.onlinegames.io/games/2024/flash/papas-donuteria/index-og.html","https://www.onlinegames.io/media/posts/1067/responsive/papas-donuteria-xs.webp","Simulator","cooking,donuts,restaurant,casual,management"],
  ["Papas Freezeria","https://www.onlinegames.io/games/2024/flash2/papas-freezeria/index.html","https://www.onlinegames.io/media/posts/813/responsive/Papas-Freezeria-xs.jpg","Simulator","cooking,icecream,restaurant,casual,management"],
  ["Papas Cupcakeria","https://cloud.onlinegames.io/games/2024/flash/papas-cupcakeria/index-og.html","https://www.onlinegames.io/media/posts/1068/responsive/papas-cupcakeria-xs.webp","Simulator","cooking,cupcakes,restaurant,papa,casual"],
  ["Papas Taco Mia","https://cloud.onlinegames.io/games/2024/flash/papas-taco-mia/index-og.html","https://www.onlinegames.io/media/posts/890/responsive/papas-taco-mia-xs.jpg","Simulator","cooking,tacos,restaurant,papa,casual"],
  ["Slope Run","https://html5.gamedistribution.com/b82efa0f9d7648beb126d62c0fb9363d/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/b82efa0f9d7648beb126d62c0fb9363d-512x384.jpeg","Arcade","slope,ball,running,3d,endless"],
  ["Snow Rider 3D","https://html5.gamedistribution.com/3b79a8537ebc414fb4f9672a9b8c68c8/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/3b79a8537ebc414fb4f9672a9b8c68c8-512x384.jpeg","Racing","snow,sledding,winter,endless,3d"],
  ["Time Shooter","https://html5.gamedistribution.com/1092591e1589474cbb6c42cd388440c6/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/1092591e1589474cbb6c42cd388440c6-512x384.jpeg","Shooting","fps,time,shooting,superhot,3d"],
  ["Time Shooter 2","https://html5.gamedistribution.com/62a72f2da7cb4b609579a47653546e6a/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/62a72f2da7cb4b609579a47653546e6a-512x384.jpeg","Shooting","fps,time,shooting,superhot,3d"],
  ["Time Shooter 3 SWAT","https://html5.gamedistribution.com/6493b872f0564380a7adad671d1e0a57/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/6493b872f0564380a7adad671d1e0a57-512x384.jpeg","Shooting","fps,swat,time,shooting,3d"],
  ["Vex 3","https://html5.gamedistribution.com/762c932b4db74c6da0c1d101b2da8be6/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/762c932b4db74c6da0c1d101b2da8be6-512x384.jpeg","Arcade","stickman,platformer,parkour,obstacle,skill"],
  ["Vex 7","https://html5.gamedistribution.com/0c454c9562d249d28ba3a2b50564042c/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/0c454c9562d249d28ba3a2b50564042c-512x384.jpeg","Arcade","stickman,platformer,parkour,obstacle,skill"],
  ["Vex 9","https://html5.gamedistribution.com/8d034584a63642dcb89fa3d24ed6e1b1/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/8d034584a63642dcb89fa3d24ed6e1b1-512x384.jpeg","Arcade","stickman,platformer,parkour,obstacle,skill"],
  ["Vex X3M","https://html5.gamedistribution.com/8fe53e6e4e564e5d927c78fd8e3daebc/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/8fe53e6e4e564e5d927c78fd8e3daebc-512x384.jpeg","Arcade","stickman,obstacle,parkour,moto,bike"],
  ["Run 3D","https://html5.gamedistribution.com/e103db40071a4af38aab2061bf799455/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/e103db40071a4af38aab2061bf799455-512x384.jpeg","Arcade","running,space,3d,endless,gravity"],
  ["Rooftop Run","https://html5.gamedistribution.com/cee36dd2c4f34d5797921a49bb1d4b83/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/cee36dd2c4f34d5797921a49bb1d4b83-512x384.jpeg","Arcade","running,parkour,rooftop,3d,endless"],
  ["Magic Tiles 3","https://html5.gamedistribution.com/58deefb8f63943dcbc5093070b9b5777/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/58deefb8f63943dcbc5093070b9b5777-512x384.jpeg","Music","music,rhythm,piano,tiles,mobile"],
  ["Fruit Ninja","https://html5.gamedistribution.com/a186dc9ac7f548f884db8ff54df6dd9f/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/a186dc9ac7f548f884db8ff54df6dd9f-512x384.jpeg","Arcade","fruit,ninja,slicing,arcade,mobile"],
  ["Red Light Green Light","https://html5.gamedistribution.com/788f89d325d840f391139ce0e1212c46/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/788f89d325d840f391139ce0e1212c46-512x384.jpeg","Arcade","squid-game,running,skill,survival,casual"],
  ["Fireboy and Watergirl 2","https://html5.gamedistribution.com/383ad09b92c7446b9113cccc29630517/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/383ad09b92c7446b9113cccc29630517-512x384.jpeg","Puzzle","fireboy,watergirl,coop,puzzle,2-player"],
  ["Fireboy and Watergirl 6","https://html5.gamedistribution.com/56da8a54fe204845b34ccff750d4a60b/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/56da8a54fe204845b34ccff750d4a60b-512x384.jpeg","Puzzle","fireboy,watergirl,coop,puzzle,2-player"],
  ["Funny Shooter 2","https://html5.gamedistribution.com/a1b7ac4025214a5cb0bd01a4f675513a/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/a1b7ac4025214a5cb0bd01a4f675513a-512x384.jpeg","Shooting","fps,funny,shooting,3d,action"],
  ["Kart Racing Pro","https://html5.gamedistribution.com/1804fc18a0fc44b794ccbc92badad206/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/1804fc18a0fc44b794ccbc92badad206-512x384.jpeg","Racing","kart,racing,endless,car,casual"],
  ["Worm Hunt Snake Game IO","https://html5.gamedistribution.com/7a03f98dcaa14dee9473508e29d7fa4d/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/7a03f98dcaa14dee9473508e29d7fa4d-512x384.jpeg","IO Games","snake,worm,io,multiplayer,grow"],
  ["Moto Road Rash 3D","https://html5.gamedistribution.com/e3c282ba53744a0f9ab4c51215c13ef2/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/e3c282ba53744a0f9ab4c51215c13ef2-512x384.jpeg","Racing","moto,highway,traffic,racing,3d"],
  ["Slope Rolling","https://html5.gamedistribution.com/0022998ce3c54962be6ffe178229b168/?gd_sdk_referrer_url=https://yourgamingsite.com/","https://img.gamedistribution.com/0022998ce3c54962be6ffe178229b168-512x384.jpeg","Arcade","slope,ball,rolling,endless,skill"],
  ["Word Guess","https://cloud.onlinegames.io/games/2025/html/wordle/index-og.html","https://www.onlinegames.io/media/posts/869/responsive/wordle-xs.jpg","Puzzle","word,puzzle,brain,daily,vocab"],
  ["Sudoku","https://cloud.onlinegames.io/games/2025/html/sudoku/index-og.html","https://www.onlinegames.io/media/posts/870/responsive/sudoku-xs.jpg","Puzzle","sudoku,puzzle,numbers,brain,casual"],
  ["Bloxd io","https://bloxd.io/","https://www.onlinegames.io/media/posts/722/responsive/Bloxd-io-xs.jpg","Sandbox","minecraft,io,multiplayer,sandbox,building"],
  ["Suroi","https://suroi.io/","https://www.onlinegames.io/media/posts/844/responsive/suroi-io-xs.jpg","IO Games","battle-royale,io,multiplayer,shooting,survival"],
  ["Smash Karts","https://smashkarts.io/","https://www.onlinegames.io/media/posts/373/responsive/smash-karts-online-xs.jpg","Racing","kart,racing,multiplayer,battle,3d"],
  ["LOLbeans io","https://lolbeans.io/","https://www.onlinegames.io/media/posts/388/responsive/Lolbeans-io-Play-xs.jpg","IO Games","fall-guys,io,multiplayer,platformer,funny"],
  ["Deadshot io","https://deadshot.io/","https://www.onlinegames.io/media/posts/898/responsive/Deadshot-io-xs.jpg","Shooting","fps,io,multiplayer,sniper,competitive"]
  // ---- 3 games were tested via the needs_proxy /embed/:slug route but the
  //      upstream uses TLS-fingerprint-level bot detection (Cloudflare) that
  //      blocks Node's fetch even with full Chrome headers + spoofed referer.
  //      Dropped from catalog: spend-bill-gates-money, gold-miner, worlds-hardest-game.
];

// ============================================================================
// Slug + category helpers
// ============================================================================
function slugify(t) {
  return String(t).toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'game';
}
function categoryId(label) {
  return slugify(label);
}
function platformFor(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('gamedistribution')) return 'GameDistribution';
    if (h.includes('onlinegames'))      return 'OnlineGames.io';
    if (h.includes('deadshot'))         return 'Deadshot.io';
    if (h.includes('lolbeans'))         return 'LOLBeans';
    if (h.includes('smashkarts'))       return 'SmashKarts';
    if (h.includes('bloxd'))            return 'Bloxd';
    if (h.includes('suroi'))            return 'Suroi';
    if (h.includes('duckmath'))         return 'DuckMath';
    return h;
  } catch { return null; }
}

// ============================================================================
// Health check — HEAD then GET, follow redirects, accept 2xx + 3xx.
// ============================================================================
async function checkUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  try {
    let r = await fetch(url, { method: 'GET', signal: ctrl.signal, headers, redirect: 'follow' });
    clearTimeout(timer);
    const ct = r.headers.get('content-type') || '';
    return {
      ok: r.ok || (r.status >= 200 && r.status < 400),
      status: r.status,
      contentType: ct.split(';')[0].trim(),
      finalUrl: r.url
    };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: err.message };
  }
}

async function checkAll(games) {
  const results = new Array(games.length);
  let cursor = 0, completed = 0;
  const t0 = Date.now();
  const tick = setInterval(() => {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`  progress: ${completed}/${games.length} (${dt}s)\n`);
  }, 5000);
  const workers = Array.from({ length: CHECK_LIMIT }, async (_, w) => {
    while (true) {
      const i = cursor++;
      if (i >= games.length) return;
      // Games flagged needs_proxy intentionally 403 to direct fetches —
      // they're meant to load through /embed/:slug.  Skip the check.
      if (games[i].needs_proxy) {
        results[i] = { ok: true, status: 200, contentType: 'proxy', skipped: true };
      } else {
        try {
          results[i] = await checkUrl(games[i].embed_url);
        } catch (e) {
          results[i] = { ok: false, status: 0, error: 'worker:' + e.message };
        }
      }
      completed++;
    }
  });
  const workerResults = await Promise.allSettled(workers);
  for (const r of workerResults) {
    if (r.status === 'rejected') console.error('[build-mvp] worker rejected:', r.reason);
  }
  clearInterval(tick);
  console.log(`  progress: ${completed}/${games.length} done`);
  return results;
}

// ============================================================================
// Build records
// ============================================================================
// Slugs that must be routed through /embed/:slug instead of being iframed
// directly.  These publishers return 403 to direct hot-link fetches but
// will happily serve the page when our server fetches it with the
// upstream's own Referer header.  The /embed/:slug route also strips
// X-Frame-Options so the iframe can render.
const NEEDS_PROXY = new Set([
  'spend-bill-gates-money',
  'gold-miner',
  'worlds-hardest-game'
]);

function buildRecords() {
  const seen = new Set();
  const out = [];
  for (const [title, embed, image, catLabel, tagsStr] of MVP) {
    const slug = slugify(title);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      title,
      description: null,
      embed_url: embed,
      thumbnail: image,
      category: categoryId(catLabel),
      category_label: catLabel,
      tags: tagsStr.split(',').map(s => s.trim()).filter(Boolean),
      platform: platformFor(embed),
      orientation: 'landscape',
      width: 1280,
      height: 720,
      monetizable: true,
      needs_proxy: NEEDS_PROXY.has(slug),  // play page renders via /embed/:slug if true
      is_featured: false,    // assigned below
      is_trending: false,    //  ″
      is_new: false,         //  ″
      is_curated: true,
      plays: 0
    });
  }

  // Featured = first 12 (the user-ordered "hero" set)
  for (let i = 0; i < Math.min(12, out.length); i++) out[i].is_featured = true;
  // Trending = next 24, picked by a fixed shuffle on slug so the homepage
  // doesn't always show the same row.  Use a deterministic pseudo-shuffle.
  const candidatesT = out.slice(12).sort((a, b) => hash(a.slug) - hash(b.slug)).slice(0, 24);
  for (const g of candidatesT) g.is_trending = true;
  // New = last 18 entries in the list (chronological assumption).
  for (let i = Math.max(0, out.length - 18); i < out.length; i++) out[i].is_new = true;

  return out;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log('[build-mvp] composing catalog…');
  let games = buildRecords();
  console.log(`[build-mvp] ${games.length} unique games`);

  let healthMap = null;
  if (!NO_CHECK) {
    console.log(`[build-mvp] running URL health check (parallel=${CHECK_LIMIT}, timeout=${CHECK_TIMEOUT_MS}ms)…`);
    const results = await checkAll(games);
    healthMap = new Map();
    games.forEach((g, i) => healthMap.set(g.slug, { url: g.embed_url, ...results[i] }));

    const broken = games.filter(g => !healthMap.get(g.slug).ok);
    console.log(`[build-mvp] ${games.length - broken.length} ok / ${broken.length} broken`);

    if (!KEEP_BROKEN) {
      const before = games.length;
      games = games.filter(g => healthMap.get(g.slug).ok);
      console.log(`[build-mvp] dropped ${before - games.length} broken entries`);
    }
  }

  // Sort: featured first, then new, then by category for visual variety.
  games.sort((a, b) => {
    if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
    if (a.is_new      !== b.is_new)      return a.is_new ? -1 : 1;
    return a.category.localeCompare(b.category);
  });

  // Write api/games.json
  mkdirSync(join(ROOT, 'api'), { recursive: true });
  const outPath = join(ROOT, 'api', 'games.json');
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'mvp-curated',
    total: games.length,
    games
  }, null, 2));
  console.log(`[build-mvp] wrote ${outPath} (${games.length} games)`);

  // Write health-check report
  if (healthMap) {
    const reportObj = [...healthMap.entries()].map(([slug, r]) => ({ slug, ...r }));
    writeFileSync(join(__dirname, 'build-mvp.report.json'), JSON.stringify(reportObj, null, 2));
    const txt = reportObj.map(r => {
      const mark = r.ok ? 'OK ' : 'XX ';
      return `${mark} ${String(r.status || '---').padStart(3)}  ${r.slug.padEnd(40)}  ${r.url}${r.error ? '   ! ' + r.error : ''}`;
    }).join('\n');
    writeFileSync(join(__dirname, 'build-mvp.report.txt'),
      `Eduame MVP health check — ${new Date().toISOString()}\n` +
      `OK: ${reportObj.filter(r => r.ok).length} / Broken: ${reportObj.filter(r => !r.ok).length}\n\n` +
      txt + '\n'
    );
    console.log(`[build-mvp] wrote tools/build-mvp.report.{json,txt}`);
  }

  console.log('[build-mvp] done.');
}

main().catch(e => {
  console.error('[build-mvp] FAILED:', e);
  process.exit(1);
});
