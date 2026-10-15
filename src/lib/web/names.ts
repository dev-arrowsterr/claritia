// A fun, stable name for every website visitor, made from their device id (the same lists as Arrowsterr).
// 200 adjectives × 200 nouns. The same device always gets the same name and color.

const ADJECTIVES = [
  "Sleepy", "Caffeinated", "Suspicious", "Turbo", "Grumpy", "Sneaky", "Dramatic", "Wobbly", "Fancy", "Chill",
  "Curious", "Bouncy", "Sassy", "Mighty", "Tiny", "Fluffy", "Spicy", "Cosmic", "Jolly", "Zesty",
  "Brave", "Clumsy", "Cheeky", "Dizzy", "Fearless", "Fuzzy", "Giggly", "Gleeful", "Goofy", "Groovy",
  "Hasty", "Hungry", "Jazzy", "Jumpy", "Lucky", "Lumpy", "Merry", "Nerdy", "Nifty", "Peppy",
  "Plucky", "Quirky", "Rowdy", "Rusty", "Salty", "Shiny", "Silly", "Snappy", "Snazzy", "Sparkly",
  "Speedy", "Sporty", "Squishy", "Stealthy", "Sunny", "Swanky", "Thrifty", "Tipsy", "Tricky", "Wacky",
  "Witty", "Zany", "Breezy", "Bubbly", "Chunky", "Crispy", "Dapper", "Dreamy", "Feisty", "Frosty",
  "Gentle", "Glittery", "Hyper", "Lazy", "Loud", "Mellow", "Mysterious", "Noble", "Peculiar", "Perky",
  "Polite", "Punchy", "Quiet", "Radiant", "Restless", "Rocket", "Royal", "Rugged", "Scrappy", "Shy",
  "Smooth", "Snoozy", "Sparky", "Spunky", "Steady", "Sturdy", "Sugary", "Super", "Swift", "Tangy",
  "Tidy", "Toasty", "Trusty", "Twinkly", "Unbothered", "Vivid", "Wandering", "Whimsical", "Wiggly", "Wise",
  "Zippy", "Ambitious", "Anxious", "Bashful", "Bold", "Bossy", "Busy", "Calm", "Candid", "Charming",
  "Chatty", "Clever", "Cozy", "Crafty", "Crunchy", "Daring", "Dazzling", "Eager", "Electric", "Epic",
  "Fierce", "Fizzy", "Flashy", "Fresh", "Frisky", "Funky", "Gallant", "Glamorous", "Golden", "Gracious",
  "Hearty", "Heroic", "Humble", "Icy", "Jittery", "Keen", "Kooky", "Legendary", "Lively", "Loyal",
  "Magic", "Majestic", "Marvelous", "Meticulous", "Mischievous", "Modest", "Neon", "Nimble", "Nosy", "Optimistic",
  "Patient", "Picky", "Playful", "Posh", "Proud", "Puzzled", "Quick", "Rambunctious", "Rare", "Regal",
  "Relaxed", "Rosy", "Savvy", "Scholarly", "Serene", "Skeptical", "Slick", "Sly", "Soggy", "Spiffy",
  "Splendid", "Starry", "Stubborn", "Stylish", "Sweet", "Tenacious", "Thoughtful", "Thunderous", "Tropical", "Upbeat",
  "Velvet", "Vigilant", "Warm", "Wild", "Windy", "Wonky", "Yawning", "Youthful", "Zealous", "Zen",
];

const NOUNS = [
  "Narwhal", "Otter", "Pancake", "Llama", "Dumpling", "Avocado", "Penguin", "Taco", "Panda", "Koala",
  "Sloth", "Flamingo", "Hedgehog", "Raccoon", "Walrus", "Octopus", "Unicorn", "Dragon", "Dinosaur", "Giraffe",
  "Hamster", "Bunny", "Fox", "Owl", "Parrot", "Peacock", "Turtle", "Frog", "Lobster", "Crab",
  "Shrimp", "Squid", "Dolphin", "Whale", "Shark", "Seal", "Badger", "Beaver", "Bison", "Camel",
  "Kangaroo", "Zebra", "Hippo", "Rhino", "Elephant", "Mammoth", "Gorilla", "Orangutan", "Monkey", "Tiger",
  "Lion", "Leopard", "Wolf", "Bear", "Polar Bear", "Moose", "Deer", "Goat", "Sheep", "Alpaca",
  "Pig", "Cow", "Chicken", "Duck", "Goose", "Swan", "Eagle", "Dodo", "Bat", "Mouse",
  "Squirrel", "Chipmunk", "Skunk", "Snail", "Ladybug", "Bee", "Butterfly", "Beetle", "Cricket", "Jellyfish",
  "Pufferfish", "Goldfish", "Seahorse", "Lizard", "Gecko", "Chameleon", "Croissant", "Bagel", "Pretzel", "Waffle",
  "Donut", "Cupcake", "Cookie", "Muffin", "Pie", "Cheesecake", "Macaron", "Pudding", "Popsicle", "Gelato",
  "Burrito", "Nacho", "Pizza", "Noodle", "Ramen", "Sushi", "Onigiri", "Bao", "Spring Roll", "Pho",
  "Burger", "Hot Dog", "Fry", "Meatball", "Falafel", "Waffle Cone", "Mango", "Pineapple", "Banana", "Coconut",
  "Kiwi", "Peach", "Cherry", "Lemon", "Blueberry", "Strawberry", "Watermelon", "Grape", "Pear", "Melon",
  "Potato", "Carrot", "Broccoli", "Pickle", "Pepper", "Mushroom", "Pumpkin", "Corn", "Peanut", "Chestnut",
  "Cactus", "Sunflower", "Tulip", "Cloud", "Comet", "Rocket", "Satellite", "Robot", "Alien", "Ghost",
  "Wizard", "Ninja", "Pirate", "Astronaut", "Viking", "Knight", "Detective", "Chef", "Cowboy", "Mermaid",
  "Yeti", "Kraken", "Phoenix", "Griffin", "Gnome", "Troll", "Pixel", "Meteor", "Volcano", "Tornado",
  "Rainbow", "Snowflake", "Lightning", "Moonbeam", "Starfish", "Bubble", "Balloon", "Kite", "Yo-Yo", "Teapot",
  "Toaster", "Kettle", "Espresso", "Boba", "Smoothie", "Lemonade", "Cocoa", "Matcha", "Marshmallow", "Jellybean",
  "Noodle Cat", "Corgi", "Pug", "Poodle", "Kitten", "Puppy", "Hamburger", "Trombone", "Ukulele", "Accordion",
];

const COLORS = ["#0943B0", "#F5B70A", "#28A745", "#D08A4E", "#7C3AED", "#DB2777", "#0891B2", "#B3241A", "#2B3242", "#65A30D", "#EA580C", "#4F46E5"];

/** A small, fast, stable hash of a string. */
function hash(s: string, seed = 0) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Persona = { name: string; initials: string; color: string };

/** The visitor's fun name, initials and color. */
export function persona(code: string): Persona {
  const adj = ADJECTIVES[hash(code, 1) % ADJECTIVES.length];
  const noun = NOUNS[hash(code, 7) % NOUNS.length];
  return { name: `${adj} ${noun}`, initials: `${adj[0]}${noun[0]}`, color: COLORS[hash(code, 13) % COLORS.length] };
}
