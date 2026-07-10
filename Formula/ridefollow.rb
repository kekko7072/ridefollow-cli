# Homebrew formula for the RideFollow terminal client.
#
# This is the seed/source-of-truth copy. The publish workflow
# (.github/workflows/publish-cli.yml) bumps `url` + `sha256` on every release
# and pushes the result to the Homebrew tap so `brew upgrade` just works.
#
#   brew install ridefollow/tap/ridefollow      # once the tap is published
#
# Or straight from this file, without a tap:
#   brew install --formula ./cli/Formula/ridefollow.rb
require "language/node"

class Ridefollow < Formula
  desc "Follow a live RideFollow bike ride from your terminal"
  homepage "https://ridefollow.live"
  url "https://registry.npmjs.org/ridefollow/-/ridefollow-1.0.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ridefollow --version")
    assert_match "follow a live RideFollow", shell_output("#{bin}/ridefollow --help")
  end
end
