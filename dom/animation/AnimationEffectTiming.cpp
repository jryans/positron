/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/AnimationEffectTiming.h"

#include "mozilla/dom/AnimatableBinding.h"
#include "mozilla/dom/AnimationEffectTimingBinding.h"
#include "mozilla/TimingParams.h"
#include "nsAString.h"

namespace mozilla {
namespace dom {

JSObject*
AnimationEffectTiming::WrapObject(JSContext* aCx, JS::Handle<JSObject*> aGivenProto)
{
  return AnimationEffectTimingBinding::Wrap(aCx, this, aGivenProto);
}

static inline void
PostSpecifiedTimingUpdated(KeyframeEffect* aEffect)
{
  if (aEffect) {
    aEffect->NotifySpecifiedTimingUpdated();
  }
}

void
AnimationEffectTiming::SetDelay(double aDelay)
{
  // TODO: Bug 1244633 - implement AnimationEffectTiming delay
}

void
AnimationEffectTiming::SetEndDelay(double aEndDelay)
{
  TimeDuration endDelay = TimeDuration::FromMilliseconds(aEndDelay);
  if (mTiming.mEndDelay == endDelay) {
    return;
  }
  mTiming.mEndDelay = endDelay;

  PostSpecifiedTimingUpdated(mEffect);
}

void
AnimationEffectTiming::SetFill(const FillMode& aFill)
{
  // TODO: Bug 1244637 - implement AnimationEffectTiming fill
}

void
AnimationEffectTiming::SetIterationStart(double aIterationStart,
                                         ErrorResult& aRv)
{
  if (mTiming.mIterationStart == aIterationStart) {
    return;
  }

  TimingParams::ValidateIterationStart(aIterationStart, aRv);
  if (aRv.Failed()) {
    return;
  }

  mTiming.mIterationStart = aIterationStart;

  PostSpecifiedTimingUpdated(mEffect);
}

void
AnimationEffectTiming::SetIterations(double aIterations, ErrorResult& aRv)
{
  if (mTiming.mIterations == aIterations) {
    return;
  }

  TimingParams::ValidateIterations(aIterations, aRv);
  if (aRv.Failed()) {
    return;
  }

  mTiming.mIterations = aIterations;

  PostSpecifiedTimingUpdated(mEffect);
}

void
AnimationEffectTiming::SetDuration(const UnrestrictedDoubleOrString& aDuration,
                                   ErrorResult& aRv)
{
  Maybe<StickyTimeDuration> newDuration =
    TimingParams::ParseDuration(aDuration, aRv);
  if (aRv.Failed()) {
    return;
  }

  if (mTiming.mDuration == newDuration) {
    return;
  }

  mTiming.mDuration = newDuration;

  PostSpecifiedTimingUpdated(mEffect);
}

void
AnimationEffectTiming::SetDirection(const PlaybackDirection& aDirection)
{
  if (mTiming.mDirection == aDirection) {
    return;
  }

  mTiming.mDirection = aDirection;

  PostSpecifiedTimingUpdated(mEffect);
}

void
AnimationEffectTiming::SetEasing(const nsAString& aEasing, ErrorResult& aRv)
{
  // TODO: Bug 1244643 - implement AnimationEffectTiming easing
}

} // namespace dom
} // namespace mozilla
